// The lines the inbox's parts came from (#6067). A split line resolves (its
// parts are what is filed), so it is not on the pending page; the page still
// shows it, as the parent its parts sit under, with how it came apart and
// whether the parts add up. One summary per parent, for the inbox and the
// assistant alike.

import type { Kysely } from "kysely";
import { splitCheckSentence, splitHeadline, splitHowOf, SPLIT_HOW_WORDS, splitParentIdOf, withoutStoreCopySuffix, type SplitParentSummary } from "@cobblr/platform-contract/split-line";
import type { CoreScanDB } from "../db.js";

type Meta = Record<string, unknown>;
const metaOf = (r: { suggested_metadata?: unknown }): Meta => (r.suggested_metadata ?? {}) as Meta;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The parents of these rows, each summarised. Rows that are no part of a
 *  split ask for nothing. */
export async function splitParentsOf(
  db: Kysely<CoreScanDB>,
  rows: ReadonlyArray<{ id: string; suggested_metadata?: unknown }>,
): Promise<{ summaries: Record<string, SplitParentSummary>; parents: Array<Record<string, unknown> & { id: string }> }> {
  const ids = [...new Set(rows.map((r) => splitParentIdOf(r.suggested_metadata)).filter((x): x is string => !!x))].slice(0, 200);
  if (!ids.length) return { summaries: {}, parents: [] };
  const parents = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "in", ids).execute();
  const partIds = [
    ...new Set(
      parents.flatMap((p) => {
        const m = metaOf(p);
        return [...(Array.isArray(m.split_into) ? m.split_into : []), ...(Array.isArray(m.split_off_into) ? m.split_off_into : [])].filter((x): x is string => typeof x === "string");
      }),
    ),
  ];
  const parts = partIds.length
    ? await db.selectFrom("core_scan_inbox_items").select(["id", "status", "quantity", "suggested_metadata"]).where("id", "in", partIds).execute()
    : [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const summaries: Record<string, SplitParentSummary> = {};
  for (const p of parents) {
    const m = metaOf(p);
    const mine = (Array.isArray(m.split_into) ? m.split_into : Array.isArray(m.split_off_into) ? m.split_off_into : [])
      .filter((x): x is string => typeof x === "string")
      .map((id) => byId.get(id))
      .filter((x): x is NonNullable<typeof x> => !!x && x.status !== "discarded");
    const unitsOf = (q: unknown) => Math.max(1, Math.round(Number(q ?? 1)) || 1);
    const units = mine.reduce((s, c) => s + unitsOf(c.quantity), 0);
    const unknown = mine.filter((c) => {
      const cm = metaOf(c);
      return (cm.store_product as { colour_unread?: unknown } | undefined)?.colour_unread === true || ("pack_colour" in cm && cm.pack_colour === null);
    }).reduce((s, c) => s + unitsOf(c.quantity), 0);
    const pending = p.status === "pending";
    const pack = m.line_pack as { count?: unknown } | undefined;
    // A line still open (Split off) holds its own units beside the parts.
    // What the parts are checked against: the line's own count when it says
    // one (a pack of 10), or what a line still open held before its split-offs.
    // A photo of two things was one row of quantity 1, not a count of one:
    // checked against itself, never "2 of 1" (the owner's humidifiers, #6067).
    const whole = num(pack?.count) ?? (pending ? units + unitsOf(p.quantity) : units);
    const how = splitHowOf(p);
    const filed = mine.filter((c) => c.status === "resolved").length;
    summaries[p.id] = {
      id: p.id,
      // A line read before intake dropped the store's copy number keeps
      // it in its name; the parent is never filed, so it is said without.
      name: p.suggested_name ? withoutStoreCopySuffix(p.suggested_name) : null,
      quantity: whole,
      line_total: num(m.line_net) ?? num(m.line_total),
      currency: typeof m.receipt_currency === "string" ? m.receipt_currency : null,
      how,
      how_words: how ? SPLIT_HOW_WORDS[how] : null,
      headline: pending ? `${units} of its ${whole} split off` : splitHeadline({ units, rows: mine.length, pack: !!pack || m.pack_split === true }),
      check: splitCheckSentence({ units, of: pending ? null : whole, unknown }),
      parts: mine.map((c) => c.id),
      filed,
      can_undo: !pending && filed === 0,
      pending,
    };
  }
  return { summaries, parents: parents as Array<Record<string, unknown> & { id: string }> };
}
