// A receipt line into its parts (#5719, #5734): one place for every door.
// A pack the store's page took apart (pack-parts.ts), a line a person says
// is "a pack of 10 different", and "split off 2 that differ" all make their
// rows here, so each part carries the line's order link and its share of the
// money, and the undo is the one the photo split already has.

import type { Kysely } from "kysely";
import { amountOf, centsFromAmount, type Cents } from "@cobblr/platform-contract/money";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { SCAN_UNDO_ACTIONS } from "@cobblr/platform-contract/scan-recovery";

/** What a receipt line carries to each part: where it was bought, and when. */
export const CARRIED = [
  "source",
  "receipt_group_id",
  "receipt_vendor",
  "receipt_date",
  "receipt_currency",
  "receipt_renewal",
  "parse_method",
  "receipt_source",
  "receipt_origin",
  "receipt_seller",
  "expected_arrival",
  "store_host",
] as const;

export interface RowPart {
  name: string;
  /** How many of the line's units it holds. */
  n: number;
  /** Its own keys (a colour, a photo, a pack note). */
  meta?: Record<string, unknown>;
}

export interface PartsRow {
  id: string;
  scan_batch_id: string | null;
  created_by_user_id: string | null;
  ai_notes: string | null;
  quantity?: number | string | null;
}

export type Admit = (values: Record<string, unknown>) => Promise<{ id: string }>;

type PackWords = { count?: unknown; each?: unknown; whole?: unknown; colour?: unknown };
const squash = (v: unknown) => (typeof v === "string" ? v.toLowerCase().replace(/\s+/g, "") : "");

/** The pack's whole amount as its line wrote it ("10 kg"), or worked out
 *  from its count and each ("10" x "1 kg"). */
function wholeOf(whole: unknown, pack?: PackWords | null): string | null {
  if (typeof whole === "string" && whole.trim()) return whole;
  const n = typeof pack?.count === "number" ? pack.count : null;
  const each = typeof pack?.each === "string" ? pack.each.match(/^\s*([\d.]+)\s*([a-z]+)\s*$/i) : null;
  return n && each ? `${Number(each[1]) * n} ${each[2]}` : null;
}

/** A part's name without the option that names the whole pack: one spool of
 *  a ten-spool pack is not "10KG" (#6456). */
export function partNameWithoutWhole(name: string, whole: unknown, pack?: PackWords | null): string {
  const w = squash(wholeOf(whole, pack));
  if (!w) return name;
  const segs = name.split(" / ");
  const kept = segs.filter((s) => squash(s) !== w);
  return kept.length && kept.length < segs.length ? kept.join(" / ") : name;
}

/**
 * The line's route, as one of its parts carries it (#6456). The table is the
 * same product's, but a value that describes the pack as a whole is not the
 * part's: the pack's mixed colour becomes the part's own colour (or blank
 * when nobody could read it), the pack's whole amount becomes one part's,
 * the count is the part's, and the line's sentence about the pack stays on
 * the line. Every door that hands a part its line's route goes through here.
 */
export function partCandidates(list: unknown, lineMeta: Record<string, unknown>, part: { n: number; meta?: Record<string, unknown> }): unknown[] {
  if (!Array.isArray(list)) return [];
  const pack = (lineMeta.line_pack ?? {}) as PackWords;
  const mine = (part.meta?.line_pack ?? {}) as PackWords;
  const colour = part.meta && "pack_colour" in part.meta ? part.meta.pack_colour : mine.colour;
  const swaps: Array<[string, unknown]> = [];
  if (squash(pack.colour)) swaps.push([squash(pack.colour), typeof colour === "string" && colour ? colour : null]);
  const whole = wholeOf(pack.whole, pack);
  if (squash(whole)) swaps.push([squash(whole), typeof mine.each === "string" ? mine.each : typeof pack.each === "string" ? pack.each : null]);
  return list.map((c) => {
    if (!c || typeof c !== "object") return c;
    const { notes: _pack, ...rest } = c as Record<string, unknown> & { fields?: Record<string, unknown> };
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest.fields ?? {})) {
      const swap = swaps.find(([from]) => from === squash(v));
      if (!swap) fields[k] = v;
      else if (swap[1] !== null) fields[k] = swap[1];
    }
    return { ...rest, fields, quantity: part.n };
  });
}

/** What a line cost, from the most exact amount it states. */
function paidOf(meta: Record<string, unknown>): number | null {
  return typeof meta.line_net === "number" ? meta.line_net : typeof meta.line_total === "number" ? meta.line_total : null;
}

/** A total shared over parts of n units each, to the cent (largest
 *  remainder): the parts always add up to what the line cost. */
export function shareByUnits(total: number | null, ns: readonly number[]): Array<number | null> {
  if (total == null) return ns.map(() => null);
  const units = ns.reduce((s, n) => s + n, 0);
  const cents = centsFromAmount(total);
  const each = Math.floor(cents / units);
  let left = cents - each * units;
  return ns.map((n) => {
    const extra = Math.min(left, n);
    left -= extra;
    return amountOf((each * n + extra) as Cents);
  });
}

function partValues(row: PartsRow, meta: Record<string, unknown>, part: RowPart, share: number | null, link: Record<string, unknown>): Record<string, unknown> {
  const carried = Object.fromEntries(CARRIED.filter((k) => meta[k] !== undefined).map((k) => [k, meta[k]]));
  return {
    source_kind: "receipt",
    scan_batch_id: row.scan_batch_id,
    suggested_name: part.name.slice(0, 300),
    quantity: part.n,
    created_by_user_id: row.created_by_user_id,
    suggested_metadata: JSON.stringify({
      ...carried,
      description: part.name,
      ...link,
      ...(part.meta ?? {}),
      ...(share != null ? { line_total: share, unit_price: amountOf(Math.round(centsFromAmount(share) / part.n) as Cents) } : {}),
    }),
  };
}

/** The line becomes its parts: one row each, the line resolved with
 *  `split_into` so Undo split puts it back while nothing is filed. */
export async function splitRowIntoParts(
  o: { db: Kysely<CoreScanDB>; admit: Admit },
  row: PartsRow,
  meta: Record<string, unknown>,
  parts: readonly RowPart[],
  done: { note: string; mark?: Record<string, unknown> },
): Promise<string[]> {
  const shares = shareByUnits(paidOf(meta), parts.map((p) => p.n));
  const children: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    children.push((await o.admit(partValues(row, meta, parts[i]!, shares[i] ?? null, { split_from: row.id }))).id);
  }
  await o.db
    .updateTable("core_scan_inbox_items")
    .set({
      status: "resolved",
      suggested_metadata: mergeMeta({ split_into: children, split_prior_notes: row.ai_notes ?? null, ...(done.mark ?? {}) }) as never,
      ai_notes: done.note,
      resolved_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", row.id)
    .execute();
  return children;
}

/** Some of a line's units are not like the rest ("8 white, 2 black"): they
 *  leave as one row of their own, the line keeps the others and stays where
 *  it is, and each keeps its share of the money. */
export async function splitOffPart(
  o: { db: Kysely<CoreScanDB>; admit: Admit },
  row: PartsRow,
  meta: Record<string, unknown>,
  part: RowPart,
): Promise<string> {
  const total = Math.round(Number(row.quantity ?? 1));
  const kept = total - part.n;
  if (!(part.n >= 1) || kept < 1) throw new Error(`a line of ${total} can split off between 1 and ${total - 1}`);
  const [keptShare, offShare] = shareByUnits(paidOf(meta), [kept, part.n]);
  const child = await o.admit(partValues(row, meta, part, offShare ?? null, { split_off_from: row.id }));
  const offs = Array.isArray(meta.split_off_into) ? (meta.split_off_into as string[]) : [];
  await o.db
    .updateTable("core_scan_inbox_items")
    .set({
      quantity: kept,
      suggested_metadata: mergeMeta({
        split_off_into: [...offs, child.id],
        ...(keptShare != null ? { line_total: keptShare, unit_price: amountOf(Math.round(centsFromAmount(keptShare) / kept) as Cents) } : {}),
        ...(keptShare != null && typeof meta.line_net === "number" ? { line_net: keptShare } : {}),
      }, ["line_units"]) as never,
      updated_at: new Date(),
    })
    .where("id", "=", row.id)
    .execute();
  return child.id;
}

/** A part split off goes back into its line: the line takes its units and
 *  its money back, and the part is gone. Refused once the part is filed. */
export async function rejoinPart(db: Kysely<CoreScanDB>, partId: string): Promise<{ ok: true; lineId: string } | { ok: false; code: "not_split_off" | "filed"; message: string }> {
  const part = await db.selectFrom("core_scan_inbox_items").select(["id", "status", "quantity", "suggested_name", "suggested_metadata"]).where("id", "=", partId).executeTakeFirst();
  const pm = (part?.suggested_metadata ?? {}) as { split_off_from?: unknown; line_total?: unknown };
  const lineId = typeof pm.split_off_from === "string" ? pm.split_off_from : null;
  if (!part || !lineId) return { ok: false, code: "not_split_off", message: "This line was not split off another, so there is nothing to put it back into." };
  if (part.status === "resolved") return { ok: false, code: "filed", message: `"${part.suggested_name ?? "This line"}" is already filed. Press ${SCAN_UNDO_ACTIONS.sendBack} on it in Recently committed first.` };
  const line = await db.selectFrom("core_scan_inbox_items").select(["id", "quantity", "suggested_metadata"]).where("id", "=", lineId).executeTakeFirst();
  if (!line) return { ok: false, code: "not_split_off", message: "The line it came from is gone." };
  const lm = (line.suggested_metadata ?? {}) as { line_total?: unknown; line_net?: unknown; split_off_into?: unknown };
  const qty = Math.round(Number(line.quantity ?? 1)) + Math.round(Number(part.quantity ?? 1));
  const back = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? amountOf((centsFromAmount(a) + centsFromAmount(b)) as Cents) : null);
  const total = back(lm.line_total, pm.line_total);
  const net = back(lm.line_net, pm.line_total);
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      quantity: qty,
      suggested_metadata: mergeMeta({
        split_off_into: (Array.isArray(lm.split_off_into) ? (lm.split_off_into as string[]) : []).filter((x) => x !== partId),
        ...(total != null ? { line_total: total, unit_price: amountOf(Math.round(centsFromAmount(total) / qty) as Cents) } : {}),
        ...(net != null ? { line_net: net } : {}),
      }) as never,
      updated_at: new Date(),
    })
    .where("id", "=", lineId)
    .execute();
  await db
    .updateTable("core_scan_inbox_items")
    .set({ status: "discarded", suggested_metadata: mergeMeta({ rejoined_into: lineId }) as never, updated_at: new Date() })
    .where("id", "=", partId)
    .execute();
  return { ok: true, lineId };
}
