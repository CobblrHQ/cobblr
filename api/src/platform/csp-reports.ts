// Content-Security-Policy violations, counted (#3300, 2026-10-11). The app's
// policy is ENFORCED (docker/nginx.conf) and names /api/v1/csp-reports as its
// report-uri, so every refusal a browser makes is posted here. A source the
// policy forgot shows up as rows, not only as a line in one person's console.
//
// What a report may cost: the endpoint takes no session (a browser posts it), so
// a row is one (day, directive, blocked source, page) and its count. The blocked
// source is reduced to its origin or its kind ("inline", "eval", "data"), the page
// to its path with ids and tokens folded, so the table grows with the number of
// distinct problems, never with traffic or with what a caller types.
import { sql } from "kysely";

export interface CspViolation {
  directive: string;
  blocked: string;
  page: string;
}

const MAX = 120;
const clip = (s: string) => s.slice(0, MAX);

/** The blocked source as its origin or its kind: never a full URL, which can
 *  carry a token. Pure. */
export function blockedSource(raw: unknown): string {
  const v = String(raw ?? "").trim();
  if (!v) return "(none)";
  if (/^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink)$/.test(v)) return v;
  if (/^(data|blob|about|javascript|filesystem):?/i.test(v)) return v.split(":")[0]!.toLowerCase();
  try {
    return clip(new URL(v).origin);
  } catch {
    return clip(v.replace(/[^a-z0-9:./_-]/gi, "").slice(0, 40)) || "(unreadable)";
  }
}

/** A page's path with what varies per record or person folded away. Pure. */
export function pagePath(raw: unknown): string {
  let p: string;
  try {
    p = new URL(String(raw ?? "")).pathname;
  } catch {
    p = String(raw ?? "").split(/[?#]/)[0] ?? "";
  }
  return clip(
    p
      .replace(/^\/w\/[^/]+/, "/w/:workspace")
      .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id")
      .replace(/\/\d+(?=\/|$)/g, "/:n")
      .replace(/\/(email-change\/revert|try\/join|reset|verify|email-change|invite|join|t|p|qr|a)\/[^/]+/g, "/$1/:token")
      .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/:token") || "/",
  );
}

/** The violations in one POST body: the old `application/csp-report` shape
 *  ({"csp-report": {...}}) and the Reporting API's array. At most ten. Pure. */
export function violationsIn(body: unknown): CspViolation[] {
  const items: Array<Record<string, unknown>> = [];
  if (Array.isArray(body)) {
    for (const r of body) if (r && typeof r === "object" && (r as { type?: string }).type === "csp-violation") items.push(((r as { body?: unknown }).body ?? {}) as Record<string, unknown>);
  } else if (body && typeof body === "object" && "csp-report" in body) {
    items.push(((body as Record<string, unknown>)["csp-report"] ?? {}) as Record<string, unknown>);
  }
  return items.slice(0, 10).map((r) => ({
    directive: clip(String(r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"] ?? "(unknown)").split(" ")[0]!),
    blocked: blockedSource(r["blocked-uri"] ?? r.blockedURL),
    page: pagePath(r["document-uri"] ?? r.documentURL),
  }));
}

let prunedOn = "";
export async function recordViolations(list: CspViolation[], now = new Date()): Promise<void> {
  const { meta } = await import("../db/meta.js");
  const day = now.toISOString().slice(0, 10);
  // Thirty days is plenty to see a source the policy forgot; once a day per process.
  if (prunedOn !== day) {
    prunedOn = day;
    await meta.deleteFrom("csp_violations").where("day", "<", sql<string>`(current_date - 30)::text`).execute();
  }
  for (const v of list) {
    console.warn(`[csp] refused ${v.blocked} for ${v.directive} on ${v.page}`);
    await meta
      .insertInto("csp_violations")
      .values({ day, directive: v.directive, blocked: v.blocked, page: v.page, count: 1, last_seen: now })
      .onConflict((oc) => oc.columns(["day", "directive", "blocked", "page"]).doUpdateSet({ count: sql`csp_violations.count + 1`, last_seen: now }))
      .execute();
  }
}

/** The last `days` days of refusals, most frequent first. */
export async function recentViolations(days = 7) {
  const { meta } = await import("../db/meta.js");
  return meta
    .selectFrom("csp_violations")
    .select(["day", "directive", "blocked", "page", "count", "last_seen"])
    .where("day", ">=", sql<string>`(current_date - ${days}::int)::text`)
    .orderBy("count", "desc")
    .limit(500)
    .execute();
}
