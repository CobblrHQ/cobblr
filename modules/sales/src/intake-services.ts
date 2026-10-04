import { readOrderEmail } from "./order-email.js";
import { platform } from "@cobblr/platform-contract";
import { ADAPTER_TRANSIT_PROPERTY, type BuiltInServiceDef, type BuiltInConnectionDef, type BuiltInServiceContext } from "@cobblr/platform-contract/services";
import { ORDER_INTAKE_CAPABILITY, type IncomingOrder } from "@cobblr/platform-contract/order-intake";

const feed: BuiltInConnectionDef = {
  title: "Order feed", summary: "Orders from your email or another shop, read from your own free order feed.", group: "order-feed",
  config_schema: { type: "object", properties: { base_url: { type: "string", title: "Feed address", format: "uri" }, token: { type: "string", title: "Feed token", writeOnly: true }, transit: ADAPTER_TRANSIT_PROPERTY }, required: ["base_url", "token"] },
  async test(config, ctx) {
    if (!ctx.fetch) return { ok: false, reason: "unreachable", error: "Give the address of your order feed." };
    try {
      const res = await ctx.fetch({ path: "/health", headers: { authorization: `Bearer ${config.token}` }, timeoutMs: 10_000 });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid_key", error: "The order feed did not accept this token." };
      return res.status === 200 && (res.json as { ok?: boolean } | null)?.ok === true ? { ok: true, note: "The order feed answered." } : { ok: false, reason: "unknown", error: "That address did not answer as an order feed." };
    } catch { return { ok: false, reason: "unreachable", error: "The order feed did not answer. Check its address and bridge." }; }
  },
};
const woo: BuiltInConnectionDef = {
  title: "WooCommerce orders", summary: "Read sales orders from your WooCommerce store using your own read-only API key.", group: "woocommerce-orders",
  config_schema: { type: "object", properties: { base_url: { type: "string", title: "Store address", format: "uri" }, consumer_key: { type: "string", title: "Consumer key", writeOnly: true }, consumer_secret: { type: "string", title: "Consumer secret", writeOnly: true }, transit: ADAPTER_TRANSIT_PROPERTY }, required: ["base_url", "consumer_key", "consumer_secret"] },
  async test(config, ctx) {
    if (!ctx.fetch) return { ok: false, reason: "unreachable", error: "Give your store address." };
    try {
      const res = await ctx.fetch({ path: "/wp-json/wc/v3/orders?per_page=1", headers: wooAuth(config), timeoutMs: 10_000 });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid_key", error: "WooCommerce did not accept this read-only API key." };
      return res.status === 200 && Array.isArray(res.json) ? { ok: true, note: "WooCommerce orders can be read." } : { ok: false, reason: "unknown", error: `WooCommerce answered ${res.status}. Check its REST API.` };
    } catch { return { ok: false, reason: "unreachable", error: "WooCommerce did not answer. Check its address and bridge." }; }
  },
};
function wooAuth(config: Readonly<Record<string, string>> | undefined) {
  return { authorization: `Basic ${Buffer.from(`${config?.consumer_key ?? ""}:${config?.consumer_secret ?? ""}`).toString("base64")}` };
}
async function call(ctx: BuiltInServiceContext, path: string, headers: Record<string, string>) {
  if (!ctx.fetch) throw new Error("This order connection has no address.");
  let res;
  try { res = await ctx.fetch({ path, headers, timeoutMs: 15_000 }); }
  catch { throw new Error("The order source did not answer. Check its connection and bridge."); }
  if (res.status === 401 || res.status === 403) throw new Error("The order source did not accept its credential. Update the connection and try again.");
  if (res.status === 422) throw new Error("The order feed found an invalid order or email. Correct the dedicated mailbox or source reference, then check again.");
  if (res.status >= 400) throw new Error(`The order source answered ${res.status}. Check the connection and try again.`);
  return res;
}
export const ORDER_FEED_SERVICE: BuiltInServiceDef = {
  id: "sales.order-feed", name: "Order feed", capability: ORDER_INTAKE_CAPABILITY, connection: feed,
  async run(ctx) {
    const input = ctx.input as { cursor?: string | null; limit?: number };
    const q = new URLSearchParams({ limit: String(input.limit ?? 20) });
    if (input.cursor !== null && input.cursor !== undefined) q.set("cursor", input.cursor);
    const res = await call(ctx, `/orders?${q}`, { authorization: `Bearer ${ctx.config?.token ?? ""}` });
    const page = res.json as { orders?: Array<IncomingOrder & { email?: unknown }>; cursor?: string | null } | null;
    if (!page || !Array.isArray(page.orders) || page.orders.length > 20 || !(page.cursor === null || typeof page.cursor === "string")) throw new Error("The order feed returned an invalid page.");
    const orders: IncomingOrder[] = [];
    for (const entry of page.orders) {
      if (entry.email) {
        const order = await readOrderEmail(ctx.orgId, null, entry.email);
        if (order) orders.push({ ...order, source: entry.source, ref: entry.ref });
      } else orders.push(entry);
    }
    return { output: { orders, cursor: page.cursor } };
  },
};
interface WooOrder {
  id: number; number: string; status: string; date_created_gmt: string; date_modified_gmt: string; customer_note?: string;
  billing?: Record<string, string>; shipping?: Record<string, string>;
  currency: string;
  line_items: Array<{ name: string; sku: string; quantity: number; total: string; total_tax?: string }>;
  shipping_lines?: Array<{ method_title: string; total: string; total_tax?: string }>;
  fee_lines?: Array<{ name: string; total: string; total_tax?: string }>;
}
const address = (v: Record<string, string> | undefined) => v ? [v.first_name, v.last_name, v.company, v.address_1, v.address_2, v.city, v.state, v.postcode, v.country].filter(Boolean).join(" ") : "";
export const WOOCOMMERCE_ORDER_SERVICE: BuiltInServiceDef = {
  id: "sales.woocommerce-orders", name: "WooCommerce orders", capability: ORDER_INTAKE_CAPABILITY, connection: woo,
  async run(ctx) {
    const input = ctx.input as { cursor?: string | null; limit?: number };
    const cursor: { at: string; ids: number[] } | null = input.cursor ? JSON.parse(input.cursor) : null;
    if (cursor && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(cursor.at) || !Array.isArray(cursor.ids) || !cursor.ids.every((id) => Number.isSafeInteger(id) && id > 0))) throw new Error("WooCommerce has an invalid order cursor.");
    const q = new URLSearchParams({ orderby: "modified", order: "asc", per_page: String(input.limit ?? 20), dates_are_gmt: "true" });
    if (cursor) {
      q.set("modified_after", new Date(Date.parse(cursor.at + "Z") - 1000).toISOString());
      q.set("exclude", cursor.ids.join(","));
    }
    const res = await call(ctx, `/wp-json/wc/v3/orders?${q}`, wooAuth(ctx.config));
    if (!Array.isArray(res.json)) throw new Error("WooCommerce did not return a list of orders.");
    const publicAddress = new URL(ctx.config?.base_url ?? "https://store.invalid");
    publicAddress.username = ""; publicAddress.password = ""; publicAddress.search = ""; publicAddress.hash = "";
    const base = publicAddress.toString().replace(/\/+$/, "");
    const orders: IncomingOrder[] = (res.json as WooOrder[]).filter((o) => !["cancelled", "refunded", "failed", "trash"].includes(o.status)).map((o) => ({
      currency: o.currency, source: `woocommerce:${base}`, ref: String(o.id), url: `${base}/wp-admin/post.php?post=${o.id}&action=edit`, number: o.number,
      ...(o.date_created_gmt ? { date: o.date_created_gmt.slice(0, 10) } : {}), ...(o.customer_note ? { notes: o.customer_note } : {}),
      shipping_address: address(o.shipping) || address(o.billing),
      customer: { name: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ") || o.billing?.email || "Customer", ...(o.billing?.email ? { email: o.billing.email } : {}), ...(o.billing?.phone ? { phone: o.billing.phone } : {}), address: address(o.billing) },
      items: [...o.line_items.map((l) => ({ ...(l.sku ? { sku: l.sku } : {}), description: l.name, qty: l.quantity, unit_price: (Number(l.total) + Number(l.total_tax || "0")) / l.quantity })),
        ...(o.shipping_lines ?? []).map((l) => ({ description: l.method_title || "Shipping", qty: 1, unit_price: Number(l.total) + Number(l.total_tax || "0") })),
        ...(o.fee_lines ?? []).map((l) => ({ description: l.name, qty: 1, unit_price: Number(l.total) + Number(l.total_tax || "0") })),
      ],
    }));
    let next = input.cursor ?? null;
    const rows = res.json as WooOrder[];
    if (rows.length) {
      const at = rows[rows.length - 1]!.date_modified_gmt;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(at)) throw new Error("WooCommerce returned an order without its change date.");
      const ids = [...new Set([...(cursor?.at === at ? cursor.ids : []), ...rows.filter((o) => o.date_modified_gmt === at).map((o) => o.id)])];
      next = JSON.stringify({ at, ids });
      if (next.length > 4000) throw new Error("Too many store orders changed at the same instant. Use an order feed for this store.");
    }
    return { output: { orders, cursor: next } };
  },
};
export function registerIntakeServices() {
  for (const def of [ORDER_FEED_SERVICE, WOOCOMMERCE_ORDER_SERVICE]) platform().services.registerBuiltIn(def);
}
