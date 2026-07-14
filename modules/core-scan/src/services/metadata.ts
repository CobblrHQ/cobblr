// The scan item's `suggested_metadata` bag — and the one safe way to write it.
//
// The bag has ELEVEN independent writers: the barcode/vendor/web identify, the
// photo identify, the photo cross-check, the matchmaker, apply-theme, the scan
// history, the catalog-image lock, the photo gallery, the split/combine/attach
// flows, the intake inserts — and the USER (box_state, reviewed, keep_grouped).
// Several run DETACHED, tens of seconds after the request that spawned them.
//
// So a write that hands Postgres a whole new object silently destroys every key
// it didn't happen to know about. That is not a hypothetical: it shipped as
// `keep_grouped` being thrown away (a re-run erased the user's ANSWER and asked
// the question again), as `photo_distinct` being erased mid-re-run (the split
// offer vanished, then a second vision call was paid to rediscover it), and — the
// worst one — as a *transient rate-limit* replacing the entire bag with
// `{rate_limited: true}`, taking `receipt_group_id` and `import_provenance` with
// it. The old code knew: `enrichBarcodeItem` carried a `reassertLockedImage()`
// helper whose only job was to put ONE key back after the clobber.
//
// Rescuing keys one at a time does not scale and never will. Write through
// `mergeMeta()` instead: it names the keys YOUR pass owns, drops exactly those
// DB-side, and overlays your new ones — atomically, in one statement, with no
// read-modify-write. Everything anyone else wrote is untouched, including keys
// written between your SELECT and your UPDATE.
//
// Enforced by `npm run lint:jsonb-merge`.

import { sql } from "kysely";
import type { RawBuilder } from "kysely";

/**
 * Keys an IDENTIFY pass owns (barcode, vendor, web-search, photo). Each identify
 * clears all of them and re-sets what it found, so a value a NEW read no longer
 * produces (a `series` it stopped recognising, a `low_trust` flag on a code that
 * resolved cleanly this time) cannot linger from the previous run.
 */
export const IDENTIFY_OWNED_KEYS = [
  "source",
  "method",
  "category",
  "description",
  "entity_type",
  "series",
  "serial_number",
  "barcode_source",
  "fields",
  "model",
  "raw",
  "low_trust",
  "pack_size",
  "decoded",
  "enriched_from",
  "rate_limited",
  "user_hint",
  "photo_observations",
  "photo_distinct",
  "photo_individuals",
  "photo_observed_for",
  // The photo cross-check gate: a barcode hit WITH a scan photo shows as
  // "checking…" at a damped confidence until the cross-check confirms or corrects
  // it, so a collided/reused UPC never flashes a confident wrong product. Owned by
  // the identify pass that sets them; the cross-check clears them when it resolves.
  "photo_check_pending",
  "pending_confidence",
  "pending_notes",
] as const;

/**
 * Terminal markers a FRESH identity invalidates: the matchmaker must re-run
 * against the new name, and until it does the UI has to read "still working"
 * rather than showing a settled card over in-flight AI calls.
 */
export const PIPELINE_TERMINAL_KEYS = ["matched_at", "finalized_at", "match_failed"] as const;

/**
 * A jsonb expression that DROPS `drop` and then overlays `set`, evaluated against
 * the row's LIVE value. The only sanctioned way to update `suggested_metadata`.
 *
 *   suggested_metadata: mergeMeta({ source: "vision" }, IDENTIFY_OWNED_KEYS)
 *     → (coalesce(suggested_metadata,'{}') - 'source' - 'category' - …) || '{"source":"vision"}'
 *
 * `drop` keys are compile-time constants from this file, never user input.
 */
export function mergeMeta(
  set: Record<string, unknown>,
  drop: readonly string[] = [],
): RawBuilder<unknown> {
  const dropped = drop.length ? sql.raw(drop.map((k) => `- '${k}'`).join(" ")) : sql.raw("");
  return sql`(coalesce(suggested_metadata, '{}'::jsonb) ${dropped}) || ${JSON.stringify(set)}::jsonb`;
}

/** Drop keys and set nothing — e.g. releasing the user's catalog-image lock. */
export function dropMeta(drop: readonly string[]): RawBuilder<unknown> {
  return mergeMeta({}, drop);
}

/**
 * What an identify pass writes: its own keys re-set, the pipeline's terminal
 * markers cleared, and every other writer's keys left exactly as they were.
 *
 * `keep` spares an identify-owned key from the clear — for a value the NEW read
 * didn't produce but the PREVIOUS one did, and which is still true (the cached
 * observation of an unchanged photo). Without it, the alternative is to re-buy an
 * answer we already have.
 */
export function identityMeta(
  set: Record<string, unknown>,
  opts: { alsoDrop?: readonly string[]; keep?: readonly string[] } = {},
): RawBuilder<unknown> {
  const keep = new Set(opts.keep ?? []);
  const drop = [...IDENTIFY_OWNED_KEYS, ...PIPELINE_TERMINAL_KEYS, ...(opts.alsoDrop ?? [])].filter(
    (k) => !keep.has(k),
  );
  return mergeMeta(set, drop);
}
