// VOCAB-ENUMERATION OK: turning a stored receipt record back into role-keyed
// facts is the same translation receipt-facts.ts performs on a live parse, and
// naming the receipt's concepts is the job of both.
//
// Filling the fields a workspace turned on AFTER its receipts were already
// filed.
//
// Everything a parse established is kept on the item under `receipt`, whether
// or not a field claimed it (receipt-record.ts). That was the point: the answer
// survives the field not existing yet. This is the other half - when the field
// arrives, the answers already recorded can move into it.
//
// It is a deliberate, explicit action rather than something switching a preset
// on does quietly. Turning a setting on should not rewrite items you filed
// months ago without being asked.

import {
  mapRoledFacts,
  roledFactsPatch,
  platform,
  type RoledFacts,
} from "@cobblr/platform-contract";
import type { ReceiptRecord } from "./receipt-record.js";

/** The record as it sits on an item, keyed by meaning again. */
export function recordFacts(record: ReceiptRecord | null | undefined): RoledFacts {
  const facts: RoledFacts = {};
  if (!record) return facts;
  if (record.vendor) facts["acquired-from"] = record.vendor;
  else if (record.seller) facts["acquired-from"] = record.seller;
  if (record.seller && record.seller !== record.vendor) facts.seller = record.seller;
  if (record.date) facts["acquired-on"] = record.date;
  // Same rule the live parse uses: only a price the receipt's own numbers
  // corroborated. A line total is a real number that does not answer "what did
  // this cost me" once a discount or a shared shipping charge exists.
  if (typeof record.net_price === "number") facts["acquired-for"] = record.net_price;
  return facts;
}

export interface BackfillCandidate {
  id: string;
  /** The item's current field values, so a filled one is never overwritten. */
  values: Record<string, unknown>;
  record: ReceiptRecord | null;
}

export interface BackfillPatch {
  id: string;
  patch: Record<string, string | number>;
}

export interface BackfillPlan {
  patches: BackfillPatch[];
  /** Had a receipt record but every mapped field already held a value. */
  already_filled: number;
  /** Had no receipt record to draw on. */
  no_record: number;
}

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * What a backfill would write, given what each item already holds.
 *
 * Pure, because the rule that matters is "never overwrite" and that rule should
 * not need a database to prove. `mapFacts` is the caller's role mapper, passed
 * in so this file does not need to know how a workspace names anything.
 */
export function planBackfill(
  candidates: readonly BackfillCandidate[],
  mapFacts: (facts: RoledFacts) => Record<string, string | number>,
): BackfillPlan {
  const patches: BackfillPatch[] = [];
  let alreadyFilled = 0;
  let noRecord = 0;

  for (const c of candidates) {
    const facts = recordFacts(c.record);
    if (Object.keys(facts).length === 0) {
      noRecord += 1;
      continue;
    }
    const mapped = mapFacts(facts);
    const patch: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(mapped)) {
      // A value someone typed, or an earlier fill, wins. A backfill adds what is
      // missing; it never revises what is there.
      if (isEmpty(c.values[key])) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      alreadyFilled += 1;
      continue;
    }
    patches.push({ id: c.id, patch });
  }

  return { patches, already_filled: alreadyFilled, no_record: noRecord };
}

/**
 * One listed entity, as the planner needs it.
 *
 * A `ResolvedEntity` keeps its values under `fields`, NOT at the top level.
 * Reading them flat found no receipt on anything and reported all 63 items as
 * "no receipt" while their records sat right there - and every unit test still
 * passed, because they fed the planner candidates that were already shaped
 * (2026-08-23). So the shaping is its own function with its own tests.
 */
export function candidateFromRow(row: {
  id: string;
  fields?: Record<string, unknown> | undefined;
}): BackfillCandidate {
  const md = (row.fields?.metadata ?? null) as Record<string, unknown> | null;
  // A custom field's value lives in the item's metadata blob, which is also
  // where the receipt record sits.
  return {
    id: String(row.id),
    values: (md ?? {}) as Record<string, unknown>,
    record: (md?.receipt ?? null) as ReceiptRecord | null,
  };
}

/** Page size for the per-kind walk. The old single-page read made this a hard
 *  ceiling: rows past it were unreachable, re-running did not advance (no
 *  ordering was specified, so a second read could return a DIFFERENT 2000),
 *  and a one-shot miss was permanent (2026-08-25 audit). The walk now pages to
 *  the end of each kind; the per-KIND cap below is the runaway bound. */
export const BACKFILL_SCAN_CAP = 2000;
/** The most rows one kind is walked in one run - a runaway bound, not a page.
 *  A kind larger than this reports capped_at honestly, per kind. */
export const BACKFILL_KIND_CAP = 20_000;

export interface BackfillResult {
  scanned: number;
  filled: number;
  already_filled: number;
  no_receipt: number;
  by_kind: Array<{ kind: string; filled: number }>;
  dry_run?: true;
  capped_at?: number;
  /** Kinds whose walk hit BACKFILL_KIND_CAP - the honest version of the old
   *  run-wide capped_at, which accumulated ACROSS kinds and so reported three
   *  small kinds as capped while an actually-capped one was indistinguishable. */
  capped_kinds?: string[];
  /** Facts the field mapping DROPPED - a value a closed choice list refused.
   *  Nothing consumed unlistedChoice before this; a dropped vendor was
   *  indistinguishable from no vendor (2026-08-25 audit). */
  dropped_facts?: number;
}

/**
 * Move what past receipts established into the fields this workspace has now.
 *
 * Only kinds that HAVE somewhere to put these are read: a workspace that turned
 * nothing on gets an empty answer rather than a scan of everything it owns.
 */
export async function runReceiptBackfill(
  orgId: string,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const kinds = await platform().entities.listKindsForOrg(orgId);
  const cappedKinds: string[] = [];
  let droppedFacts = 0;
  let scanned = 0;
  let filled = 0;
  let alreadyFilled = 0;
  let noRecord = 0;
  const byKind: Array<{ kind: string; filled: number }> = [];

  for (const k of kinds) {
    const kindId = k.id;
    const roled = await platform().entities.roledFieldsFor(orgId, kindId);
    if (!roled.some((f) => f.field_role?.startsWith("acquired-") || f.field_role === "seller")) {
      continue;
    }
    // Page to the END of the kind. id-ordered so a page boundary cannot skip
    // or repeat rows between reads.
    const candidates: BackfillCandidate[] = [];
    for (let offset = 0; offset < BACKFILL_KIND_CAP; offset += BACKFILL_SCAN_CAP) {
      const listed = await platform().entities.list(orgId, kindId, {
        limit: BACKFILL_SCAN_CAP,
        offset,
        sort: ["id"],
      });
      const page = (listed.items ?? []).map(candidateFromRow);
      candidates.push(...page);
      if (page.length < BACKFILL_SCAN_CAP) break;
      if (offset + BACKFILL_SCAN_CAP >= BACKFILL_KIND_CAP) cappedKinds.push(kindId);
    }
    scanned += candidates.length;
    const plan = planBackfill(candidates, (facts) => {
      const mapped = mapRoledFacts(facts, roled);
      // Count what the closed choice list refused: nothing consumed
      // unlistedChoice before, so a dropped vendor was indistinguishable from
      // no vendor. The count reaches the result, and the result reaches the
      // person who ran the backfill.
      droppedFacts += mapped.filter((m) => m.unlistedChoice).length;
      return roledFactsPatch(mapped);
    });
    alreadyFilled += plan.already_filled;
    noRecord += plan.no_record;
    if (plan.patches.length === 0) continue;

    if (!opts.dryRun) {
      const writer = platform().entities.getWriter(kindId);
      if (!writer) continue;
      for (const patch of plan.patches) {
        // Merged into metadata, never replacing it: everything else on the item
        // stays exactly as it was.
        const existing = candidates.find((c) => c.id === patch.id)?.values ?? {};
        await writer.update(orgId, patch.id, { metadata: { ...existing, ...patch.patch } });
      }
    }
    filled += plan.patches.length;
    byKind.push({ kind: kindId, filled: plan.patches.length });
  }

  return {
    scanned,
    filled,
    already_filled: alreadyFilled,
    no_receipt: noRecord,
    by_kind: byKind,
    ...(opts.dryRun ? { dry_run: true as const } : {}),
    ...(cappedKinds.length ? { capped_at: BACKFILL_KIND_CAP, capped_kinds: cappedKinds } : {}),
    ...(droppedFacts ? { dropped_facts: droppedFacts } : {}),
  };
}
