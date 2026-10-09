// Read a Shopify order's own page the way the page itself does (#5461), with
// no browser: follow the email's sign-in link hop by hop carrying its
// cookies, land on the customer account's order page, take the page's access
// token, and ask the Customer Account API for the order's fulfillments. Each
// fulfillment is one parcel: its tracking number, its carrier, and the lines
// it carries in the store's own words.
//
// The link signs the buyer in. Nothing here logs it, returns it or puts it in
// an error: the outcome says what happened in words that name no URL.

export type ReadOutcome =
  /** Every shipped parcel came with its tracking number. */
  | "read"
  /** The page answered, but without tracking numbers (Shopify's guest view of
   *  an order, which a link falls back to once its sign-in has worn off). */
  | "redacted"
  /** The link no longer signs in: the chain ended at a sign-in form. */
  | "expired"
  /** The store answered 429 or 403: back off, never retry soon. */
  | "throttled"
  /** Not a Shopify customer account order page. */
  | "unsupported"
  /** Anything else: a network failure, an answer of a shape not understood. */
  | "failed";

export interface PageParcel {
  trackingNumber: string | null;
  company: string | null;
  /** "in_transit" | "out_for_delivery" | "delivered" */
  state: string;
  /** The day the store expects it, YYYY-MM-DD, when it says. */
  expectedArrival: string | null;
  /** The lines in this parcel, in the store's words ("PETG 1.75mm - US / 10KG / white"). */
  lines: Array<{ name: string; qty: number }>;
}

export interface PageRead {
  outcome: ReadOutcome;
  parcels: PageParcel[];
}

/** One request, redirects NOT followed (the caller carries the cookies). */
export type FetchHop = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

const MAX_HOPS = 12;
const UA = "Mozilla/5.0 (compatible; Cobblr order follower)";
const ORDER_PAGE = /^https:\/\/shopify\.com\/(\d+)\/account\/orders\/([0-9a-f]{32})\/?$/i;
const SIGN_IN = /\/(authentication|account\/login|account\/sign_in|login)\b/i;

class CookieJar {
  private readonly cookies = new Map<string, { domain: string; value: string }>();

  take(from: URL, res: Response): void {
    const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
      const domain = (domainAttr ? domainAttr.slice(7) : from.hostname).replace(/^\./, "").toLowerCase();
      this.cookies.set(`${domain}|${name}`, { domain, value: `${name}=${value}` });
    }
  }

  header(to: URL): string {
    const host = to.hostname.toLowerCase();
    return [...this.cookies.values()]
      .filter((c) => host === c.domain || host.endsWith(`.${c.domain}`))
      .map((c) => c.value)
      .join("; ");
  }
}

function stateOf(node: Record<string, unknown>): string {
  const has = (k: string) => Array.isArray((node[k] as { edges?: unknown[] } | undefined)?.edges) && ((node[k] as { edges: unknown[] }).edges.length > 0);
  if (has("delivered")) return "delivered";
  if (has("outForDelivery")) return "out_for_delivery";
  return "in_transit";
}

const FULFILLMENTS = `query OrderFulfillments($orderId: ID!) {
  order(id: $orderId) {
    id
    fulfillments(first: 20, sortKey: CREATED_AT, reverse: true, query: "NOT status:CANCELLED") {
      edges { node {
        id status createdAt estimatedDeliveryAt
        trackingInformation { number company }
        fulfillmentLineItems(first: 50) { nodes { quantity lineItem { presentmentName title } } }
        outForDelivery: events(first: 1, query: "status:out_for_delivery", sortKey: HAPPENED_AT, reverse: true) { edges { node { happenedAt } } }
        delivered: events(first: 1, query: "status:delivered", sortKey: HAPPENED_AT, reverse: true) { edges { node { happenedAt } } }
      } }
    }
  }
}`;

/** The parcels in a Customer Account API fulfillments answer. A parcel with
 *  no tracking information is a redacted view, never a parcel without a box. */
export function parcelsOfFulfillments(body: unknown): PageRead {
  const order = (body as { data?: { order?: { fulfillments?: { edges?: Array<{ node?: Record<string, unknown> }> } } | null } })?.data?.order;
  if (!order) return { outcome: "failed", parcels: [] };
  const parcels: PageParcel[] = [];
  let redacted = false;
  for (const edge of order.fulfillments?.edges ?? []) {
    const node = edge.node;
    if (!node) continue;
    if (String(node.status ?? "").toUpperCase() === "CANCELLED") continue;
    const tracking = (node.trackingInformation as Array<{ number?: string | null; company?: string | null }> | undefined) ?? undefined;
    const first = tracking?.find((t) => t?.number) ?? null;
    if (!first) redacted = true;
    const items = ((node.fulfillmentLineItems as { nodes?: Array<{ quantity?: number; lineItem?: { presentmentName?: string; title?: string } }> } | undefined)?.nodes ?? [])
      .map((n) => ({ name: (n.lineItem?.presentmentName || n.lineItem?.title || "").trim(), qty: Number(n.quantity ?? 1) || 1 }))
      .filter((l) => l.name);
    const eta = typeof node.estimatedDeliveryAt === "string" ? node.estimatedDeliveryAt.slice(0, 10) : null;
    parcels.push({
      trackingNumber: first?.number ? String(first.number).replace(/\s+/g, "") : null,
      company: first?.company ? String(first.company) : null,
      state: stateOf(node),
      expectedArrival: eta,
      lines: items,
    });
  }
  return { outcome: redacted ? "redacted" : "read", parcels };
}

/** The two 32-character order headers: the order page's own token first, then
 *  any 32-hex value the page names beside an order or access token key. */
export function orderHeaders(pathToken: string, html: string): { access: string; context: string } {
  const near = (key: RegExp) => {
    const m = html.match(new RegExp(`${key.source}["']?\\s*[:=]\\s*["']([0-9a-f]{32})["']`, "i"));
    return m?.[1] ?? null;
  };
  return {
    access: pathToken || near(/order_?access_?token|orderToken|accessToken/) || "",
    context: pathToken || near(/resource_?context|resourceContext/) || "",
  };
}

/** Follow the link and read the order. Never throws; never names the link. */
export async function readShopifyOrderPage(link: string, fetchHop: FetchHop): Promise<PageRead> {
  const jar = new CookieJar();
  const none = (outcome: ReadOutcome): PageRead => ({ outcome, parcels: [] });
  try {
    let url = new URL(link);
    let res: Response | null = null;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      res = await fetchHop(url.href, { headers: { "user-agent": UA, accept: "text/html,application/json", cookie: jar.header(url) } });
      jar.take(url, res);
      if (res.status === 429 || res.status === 403) return none("throttled");
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!loc) break;
      url = new URL(loc, url);
      if (SIGN_IN.test(url.pathname) && !/\/oauth\/authorize/i.test(url.pathname)) return none("expired");
    }
    if (!res || res.status !== 200) return none(res && res.status >= 300 && res.status < 400 ? "failed" : "unsupported");
    const page = ORDER_PAGE.exec(url.href.split(/[?#]/)[0] ?? "");
    if (!page) return none(SIGN_IN.test(url.pathname) ? "expired" : "unsupported");
    const [, shopId, token] = page;
    const html = await res.text();
    const base = `https://shopify.com/${shopId}/account`;
    const tokenRes = await fetchHop(`${base}/oauth/token`, { headers: { "user-agent": UA, accept: "application/json", cookie: jar.header(new URL(base)), referer: url.href } });
    if (tokenRes.status === 429 || tokenRes.status === 403) return none("throttled");
    if (tokenRes.status === 401 || (tokenRes.status >= 300 && tokenRes.status < 400)) return none("expired");
    const access = ((await tokenRes.json().catch(() => null)) as { access_token?: string } | null)?.access_token;
    if (!access) return none("expired");
    const headers = orderHeaders(token ?? "", html);
    const gql = await fetchHop(`${base}/customer/api/unstable/graphql?operation=OrderFulfillments`, {
      method: "POST",
      headers: {
        "user-agent": UA,
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://shopify.com",
        referer: url.href,
        cookie: jar.header(new URL(base)),
        authorization: access,
        "x-shopify-order-access-token": headers.access,
        "x-shopify-resource-context": headers.context,
      },
      body: JSON.stringify({ operationName: "OrderFulfillments", query: FULFILLMENTS, variables: { orderId: `gid://shopify/Order/${token}` } }),
    });
    if (gql.status === 429 || gql.status === 403) return none("throttled");
    if (gql.status === 401) return none("expired");
    if (!gql.ok) return none("failed");
    const body = (await gql.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
    if (!body) return none("failed");
    if (body.errors?.length && !(body as { data?: unknown }).data) {
      const said = body.errors.map((e) => e.message ?? "").join(" ");
      return none(/access|denied|redact|permission/i.test(said) ? "redacted" : /token|unauthor/i.test(said) ? "expired" : "failed");
    }
    return parcelsOfFulfillments(body);
  } catch {
    return none("failed");
  }
}
