// A pack's parts, one row per distinct thing (#5764). The owner: "7 unique
// lines in a 10 pack is a valid outcome." Three white spools in a pack of ten
// are one row of three, filed +3 to the one White record, beside six rows of
// one. When a person renames a part to what another part already is, the two
// become one row; a part that changes leaves its row first (split off), so
// its unit and its share of the money go with it. Money always adds up to the
// line. A part of unknown colour never merges with anything: two unknowns
// are not known to be the same.

import { sql, type Kysely } from "kysely";
import { amountOf, centsFromAmount, type Cents } from "@cobblr/platform-contract/money";
import { storeVariantOf } from "@cobblr/platform-contract/same-product";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { relineAfterChange, type PurchaseHttp } from "./receipt-purchase.js";

export interface PackPart {
  id: string;
  quantity: number | string | null;
  suggested_name: string | null;
  suggested_metadata: unknown;
}

/** What a part resolves to: its product line and colour (the store's title
 *  and the variant's last option), or its whole name; null for a part of
 *  unknown colour, which never merges. */
export function resolvedKey(p: PackPart): string | null {
  const m = (p.suggested_metadata ?? {}) as { store_product?: { colour_unread?: unknown }; unit_unnamed?: unknown; description?: unknown };
  const name = (p.suggested_name ?? "").replace(/\s+/g, " ").trim();
  if (!name || m.store_product?.colour_unread === true || /colou?r unknown/i.test(name)) return null;
  // A part split by hand still under its line's name has not been named.
  if (m.unit_unnamed === true && name === String(m.description ?? "").replace(/\s+/g, " ").trim()) return null;
  const v = storeVariantOf(name);
  return v ? `${v.base}|${v.options.at(-1)}` : name.toLowerCase();
}

export interface Merge {
  into: string;
  from: string[];
  quantity: number;
  line_total: number | null;
}

/** Which parts become one row. Given the part a person just changed, only
 *  its kind merges, and it keeps its row (the card they edited stays where it
 *  is); otherwise every kind, the first of each keeping its row. Pure. */
export function regroupPlan(parts: readonly PackPart[], keep?: string): Merge[] {
  const groups = new Map<string, PackPart[]>();
  for (const p of parts) {
    const k = resolvedKey(p);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const out: Merge[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const at = g.findIndex((p) => p.id === keep);
    // Only the changed part's own kind: a spool just split off its whites,
    // waiting to be re-coloured, is not pulled back by an edit elsewhere.
    if (keep !== undefined && at < 0) continue;
    if (at > 0) g.unshift(...g.splice(at, 1));
    const totals = g.map((p) => (p.suggested_metadata as { line_total?: unknown } | null)?.line_total);
    const line_total = totals.every((t) => typeof t === "number") ? amountOf(totals.reduce((s: number, t) => s + centsFromAmount(t as number), 0) as Cents) : null;
    out.push({ into: g[0]!.id, from: g.slice(1).map((p) => p.id), quantity: g.reduce((s, p) => s + Math.round(Number(p.quantity ?? 1)), 0), line_total });
  }
  return out;
}

/** The open parts of the pack `partId` is one of: the line's parts and what
 *  was split off them. */
async function packOf(db: Kysely<CoreScanDB>, partId: string): Promise<PackPart[]> {
  const me = await db.selectFrom("core_scan_inbox_items").select(["suggested_metadata"]).where("id", "=", partId).executeTakeFirst();
  const m = (me?.suggested_metadata ?? {}) as { split_from?: unknown; split_off_from?: unknown };
  let parent = typeof m.split_from === "string" ? m.split_from : null;
  if (!parent && typeof m.split_off_from === "string") {
    const up = await db.selectFrom("core_scan_inbox_items").select(["suggested_metadata"]).where("id", "=", m.split_off_from).executeTakeFirst();
    const um = (up?.suggested_metadata ?? {}) as { split_from?: unknown };
    parent = typeof um.split_from === "string" ? um.split_from : null;
  }
  if (!parent) return [];
  const cols = ["id", "quantity", "suggested_name", "suggested_metadata"] as const;
  const parts = await db
    .selectFrom("core_scan_inbox_items")
    .select([...cols])
    .where("status", "=", "pending")
    .where(sql<boolean>`suggested_metadata->>'split_from' = ${parent}`)
    .orderBy("created_at")
    .execute();
  const ids = parts.map((p) => p.id);
  const offs = ids.length
    ? await db.selectFrom("core_scan_inbox_items").select([...cols]).where("status", "=", "pending").where(sql<boolean>`suggested_metadata->>'split_off_from' = any(${ids})`).orderBy("created_at").execute()
    : [];
  return [...parts, ...offs] as PackPart[];
}

/** After a part changed what it is: parts of its pack that now resolve to
 *  the same thing become one row, units and money added; the order's lines
 *  follow. The ids of the rows that remain. */
export async function regroupPack(db: Kysely<CoreScanDB>, partId: string, http: PurchaseHttp | null): Promise<{ merged: Merge[] }> {
  const parts = await packOf(db, partId);
  const plan = regroupPlan(parts, partId);
  if (plan.length === 0) return { merged: [] };
  const now = new Date();
  for (const mg of plan) {
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        quantity: mg.quantity,
        suggested_metadata: mergeMeta({
          ...(mg.line_total != null ? { line_total: mg.line_total, unit_price: amountOf(Math.round(centsFromAmount(mg.line_total) / mg.quantity) as Cents) } : {}),
        }) as never,
        updated_at: now,
      })
      .where("id", "=", mg.into)
      .execute();
    await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "discarded", suggested_metadata: mergeMeta({ merged_into: mg.into }) as never, updated_at: now })
      .where("id", "in", mg.from)
      .execute();
  }
  if (http) {
    const before = parts.map((p) => p.id);
    const gone = new Set(plan.flatMap((m) => m.from));
    await relineAfterChange(db, http, before, before.filter((id) => !gone.has(id))).catch((e: Error) => console.warn("[core-scan] regroup: order lines kept:", e.message));
  }
  return { merged: plan };
}
