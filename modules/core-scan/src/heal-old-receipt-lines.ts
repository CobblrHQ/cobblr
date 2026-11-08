// One-shot heal: a receipt line read before the by-weight rule gets what the
// receipt said about it (#9270).
//
// DONE WHEN: /healthz reads 0 found and 0 failed for this shim on prod, canary,
// staging and app, or only the lines it settled as skipped, which nothing
// further can heal. It records the count itself through registerHealPass
// (noteHealShim). Nothing re-creates the shape: the till parser keeps a line's
// weight and the grocer named below it (receipt-text.ts, enrichReceiptFromText),
// and the match takes the food route from them (withWhatTheReceiptSays). Delete
// this file and its boot call then.
//
// WHY IT EXISTS: "Assorted Thin", 2.62 lb on a grocer's till receipt, was read
// before the fix with no weight and no shop, so it went to Inventory, and the
// read-time fix only reaches a line when it is read. The weight and the grocer
// were only ever in the receipt's text, which is not kept, so this reads the
// stored photo again with the local reader (never a model) and the parser as it
// is now.
//
// What it changes, and only on a pending line the local reader first read,
// that no person has touched since:
// - the line's weight, its unit and its rate, when the re-read has a weight
//   and the line has none;
// - the shop on the line, when the re-read names one and the line has none;
// - its route, through the same food route a fresh read takes, when that
//   evidence now says food and the route it has is below the review floor.
// A line is matched to the re-read only when both its position and its total
// agree. On any doubt it stays exactly as it was, and is stamped and counted
// as skipped. Every line it looks at is stamped, so none is looked at twice.
//
// BORN WITH: a fresh workspace has no rows, and every line it reads goes
// through the parser and the match above.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { fieldProvenanceOf } from "@cobblr/platform-contract/acquisition-source";
import { personNameOf } from "@cobblr/platform-contract/display-identity";
import { storedDestinationOf } from "@cobblr/platform-contract/scan-triage";
import type { MatchCandidate, ScanMenuEntry } from "./services/matchmaker.js";
import type { ParsedReceipt, ReceiptLine } from "./services/receipt-shared.js";

export const OLD_LINE_HEAL_KEY = "old_line_heal";
/** Raised when the heal learns to read more: a line stamped by an earlier
 *  version is looked at once more. 2: a misread "$" ("§") and lines numbered
 *  before same lines were combined (#9270). */
export const OLD_LINE_HEAL_VERSION = 2;
/** When the by-weight rule merged (#9284). */
export const BY_WEIGHT_SINCE = "2026-11-07T04:36:53Z";
/** Rows per workspace per visit. A visit reads one photo per session it touches. */
const PER_VISIT = 200;

export interface OldLine {
  id: string;
  status: string;
  updated_at: Date | string;
  /** updated_at to the microsecond, as text: a JS Date drops what Postgres keeps. */
  updated_stamp?: string;
  scan_batch_id: string | null;
  quantity: number | string | null;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_sku: string | null;
  barcode_text: string | null;
  source_kind: string | null;
  ai_notes: string | null;
  scan_area: string | null;
  target_module: string | null;
  target_entity_id: string | null;
  suggested_metadata: Record<string, unknown> | null;
  suggested_candidates: unknown;
}

export type OldLineWhy =
  | "person-changed"
  | "combined"
  | "no-position"
  | "position-or-total-differs"
  | "nothing-new"
  | "healed";

export interface OldLineVerdict {
  action: "heal" | "skip";
  why: OldLineWhy;
  /** Keys to add to the row's metadata. */
  set?: Record<string, unknown>;
  /** The new candidate list, when the route moved. */
  candidates?: MatchCandidate[];
}

const near = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.005;

/** Has a person said anything about this line? Then it is theirs as it is. */
export function aPersonChanged(row: OldLine): boolean {
  const meta = row.suggested_metadata ?? {};
  if (meta.user_fields || meta.reviewed === true || personNameOf(meta)) return true;
  if (storedDestinationOf(meta)?.by === "person") return true;
  if (meta.catalog_image_user_set) return true;
  return Object.values(fieldProvenanceOf(meta)).some((p) => p?.by === "person");
}

/** The receipt's item lines as rows were made from them: line N is the Nth
 *  line that is not a charge (receipts.ts materializeReceiptLines). */
export function itemLinesOf(receipt: ParsedReceipt): ReceiptLine[] {
  return receipt.items.filter((l) => !l.kind);
}

/** The re-read's lines numbered as the old read numbered them. A read before
 *  #9268 kept two lines of one product apart, so its positions count both; one
 *  after counts them as one. The old read wrote how many lines it made
 *  (`receipt_line_count`), and only the list of that length is the one its
 *  positions point into. Neither length: no list, and the line is not matched. */
export function linesAsTheOldReadNumberedThem(reread: Reread, oldCount: unknown): readonly ReceiptLine[] | null {
  if (typeof oldCount !== "number") return reread.lines;
  if (reread.count === oldCount) return reread.lines;
  if (reread.plain && reread.plain.count === oldCount) return reread.plain.lines;
  return null;
}

/** The receipt read again: its item lines, and how many lines it had in all
 *  (charges too, as `receipt_line_count` counts them). `plain` is the same read
 *  before same lines were combined. */
export interface Reread {
  lines: readonly ReceiptLine[];
  count: number;
  plain?: { lines: readonly ReceiptLine[]; count: number };
  vendor: string | null;
}

/** A receipt's lines as the heal compares them. */
export function rereadOf(receipt: ParsedReceipt, plain?: ParsedReceipt): Reread {
  return {
    lines: itemLinesOf(receipt),
    count: receipt.items.length,
    ...(plain ? { plain: { lines: itemLinesOf(plain), count: plain.items.length } } : {}),
    vendor: receipt.vendor ?? null,
  };
}

/**
 * What the heal does with one line, given the receipt read again. Pure apart
 * from the route it asks for; `route` answers the candidates a fresh read
 * would give this line with the new evidence on it, or null for no change.
 */
export function oldLineVerdict(
  row: OldLine,
  reread: Reread,
  route: (row: OldLine, meta: Record<string, unknown>) => MatchCandidate[] | null,
): OldLineVerdict {
  const meta = row.suggested_metadata ?? {};
  if (aPersonChanged(row)) return { action: "skip", why: "person-changed" };
  if (Array.isArray(meta.source_lines) && meta.source_lines.length > 1) return { action: "skip", why: "combined" };
  const at = typeof meta.receipt_line === "number" ? meta.receipt_line : NaN;
  if (!Number.isInteger(at) || at < 1) return { action: "skip", why: "no-position" };
  const line = linesAsTheOldReadNumberedThem(reread, meta.receipt_line_count)?.[at - 1];
  if (!line || !near(line.line_total, meta.line_total)) return { action: "skip", why: "position-or-total-differs" };
  const set: Record<string, unknown> = {};
  if (typeof line.weight === "number" && line.weight > 0 && meta.weight == null) {
    set.weight = line.weight;
    set.weight_unit = line.weight_unit;
    if (line.unit_price != null) set.unit_price = line.unit_price;
  }
  if (reread.vendor && !meta.receipt_vendor) set.receipt_vendor = reread.vendor;
  if (Object.keys(set).length === 0) return { action: "skip", why: "nothing-new" };
  const candidates = route(row, { ...meta, ...set });
  return { action: "heal", why: "healed", set, ...(candidates ? { candidates } : {}) };
}

/** The route a fresh read gives the line now that it carries the receipt's
 *  evidence: the food route ahead of a guess below the floor, as the match
 *  does (matchmaker.ts withWhatTheReceiptSays). */
export async function routeWithEvidence(menu: readonly ScanMenuEntry[]) {
  const { perceiveRow, withWhatTheReceiptSays } = await import("./services/matchmaker.js");
  return (row: OldLine, meta: Record<string, unknown>): MatchCandidate[] | null => {
    const stored = Array.isArray(row.suggested_candidates) ? (row.suggested_candidates as MatchCandidate[]) : [];
    if (!stored.length || !menu.length) return null;
    const next = withWhatTheReceiptSays(stored, perceiveRow({ ...row, suggested_metadata: meta } as never), [...menu]);
    return next[0] !== stored[0] ? next : null;
  };
}

interface HealDB {
  core_scan_inbox_items: OldLine & { created_at: Date };
  core_scan_batches: { id: string; source_file_id: string | null };
}

export interface OldLinesOutcome {
  healed: number;
  skipped: number;
  failed: number;
}

/** Heal one workspace. */
export async function healOldReceiptLinesIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<OldLinesOutcome> {
  const rows = (await db
    .selectFrom("core_scan_inbox_items")
    .select(sql<string>`updated_at::text`.as("updated_stamp"))
    .select([
      "id", "status", "updated_at", "scan_batch_id", "quantity", "suggested_name", "suggested_manufacturer", "suggested_sku",
      "barcode_text", "source_kind", "ai_notes", "scan_area", "target_module", "target_entity_id", "suggested_metadata", "suggested_candidates",
    ])
    .where("status", "=", "pending")
    .where("source_kind", "=", "receipt")
    .where("created_at", "<", since)
    .where("scan_batch_id", "is not", null)
    .where(sql<boolean>`suggested_metadata->>'parse_method' = 'ocr-lines'`)
    .where(sql<boolean>`coalesce((suggested_metadata->'${sql.raw(OLD_LINE_HEAL_KEY)}'->>'v')::int, 0) < ${OLD_LINE_HEAL_VERSION}`)
    .where(sql<boolean>`((suggested_metadata->'weight') is null or (suggested_metadata->>'receipt_vendor') is null)`)
    .orderBy("scan_batch_id")
    .limit(PER_VISIT)
    .execute()) as OldLine[];
  const out: OldLinesOutcome = { healed: 0, skipped: 0, failed: 0 };
  if (!rows.length) return out;

  const { parseReceipt } = await import("./services/receipt.js");
  const { shareOrderDiscount } = await import("./services/receipt-shared.js");
  const { oneLinePerProduct } = await import("./services/same-receipt-lines.js");
  const { menuFor } = await import("./services/reroute-keyword-rows.js");
  const route = await routeWithEvidence((await menuFor(orgId).catch(() => null)) ?? []);

  const stamp = async (row: OldLine, verdict: OldLineVerdict) => {
    const mark = { [OLD_LINE_HEAL_KEY]: { v: OLD_LINE_HEAL_VERSION, at: new Date().toISOString(), outcome: verdict.action === "heal" ? "healed" : "skipped", why: verdict.why } };
    const r = await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ ...(verdict.set ?? {}), ...mark })}::jsonb` as never,
        ...(verdict.candidates ? { suggested_candidates: JSON.stringify(verdict.candidates) as never } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      // Only the row as it was judged: an edit made meanwhile is the person's.
      .where(sql<boolean>`updated_at::text = ${row.updated_stamp ?? ""}`)
      .executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0) > 0;
  };

  const byBatch = new Map<string, OldLine[]>();
  for (const r of rows) byBatch.set(r.scan_batch_id!, [...(byBatch.get(r.scan_batch_id!) ?? []), r]);
  for (const [batchId, lines] of byBatch) {
    try {
      const batch = await db.selectFrom("core_scan_batches").select(["source_file_id"]).where("id", "=", batchId).executeTakeFirst();
      const read = batch?.source_file_id ? await parseReceipt(orgId, batch.source_file_id, null, null, { noModel: true }) : null;
      const reread = read?.ok
        ? (() => {
            const plain = shareOrderDiscount(read.receipt);
            return rereadOf(oneLinePerProduct(plain, null), plain);
          })()
        : { lines: [], count: 0, vendor: null };
      for (const row of lines) {
        const v = oldLineVerdict(row, reread, route);
        if (!(await stamp(row, v))) continue;
        if (v.action === "heal") out.healed++;
        else out.skipped++;
      }
    } catch (err) {
      out.failed += lines.length;
      platform().health.notePassFailure("core-scan.heal-old-receipt-lines", orgId, err);
      console.warn(`[core-scan] heal-old-receipt-lines: a session could not be read again in ${orgId}:`, (err as Error).message);
    }
  }
  console.log(`[core-scan] heal-old-receipt-lines: ${orgId} healed ${out.healed}, skipped ${out.skipped}, failed ${out.failed}`);
  return out;
}

/** Call from onBoot. */
export function registerOldReceiptLinesHeal(): void {
  registerHealPass({
    name: "core-scan.heal-old-receipt-lines",
    since: BY_WEIGHT_SINCE,
    shim: "modules/core-scan/src/heal-old-receipt-lines.ts",
    module: "core-scan",
    // Skipped lines are counted and never reopened; a failed session is read
    // again next round.
    visit: async ({ orgId, db, since }) => {
      const o = await healOldReceiptLinesIn(orgId, db as Kysely<HealDB>, since);
      return { found: o.skipped + o.failed, settled: o.failed === 0 };
    },
  });
}
