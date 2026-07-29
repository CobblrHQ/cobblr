// The catalog-photo rank CONTEXT, and the always-on (wire-fired) pass.
//
// Two surfaces ask "which photo should this item wear?": the per-item ✨ Pick
// best button (POST /inbox/:id/rank-photo-ai) and the always-on wire
// (core-scan.scan.enriched → core-scan:rank-catalog-photo). They must derive the
// item's search phrase, colour, category and reference photo IDENTICALLY, or the
// button and the automation would answer differently for the same row — the
// two-views-of-one-fact drift documented in scan-triage-one-source-of-truth.md.
// So the derivation lives here once and both call it.
//
// The difference between them is only WHO applies the pick: the button returns it
// for the client to apply (through POST /catalog-image, the one apply surface a
// user's pick uses), while the wire has no client and applies it itself, stamping
// provenance so it is legible as an automated choice and never claims the user's
// lock.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { deriveImageQuery, searchImages, selectTopCandidates } from "./ddg-images.js";
import { downloadCatalogImage } from "./enrich.js";
import { mergeMeta } from "./metadata.js";
import { rankPhotoWithAi, shouldAutoRank, type AutoRankRow } from "./rank-photo.js";

/** Candidate images sent to the model per call (the author's "grid of 9"); the user's
 *  own reference photo rides on top of these. */
export const IMAGE_BUDGET = 9;

/** The workspace opt-in for the always-on pass. OFF unless a row says otherwise:
 *  the config row isn't seeded, so a workspace that never opted in has none and
 *  the wire no-ops for free. That is also why this needs no boot reconcile for
 *  workspaces that predate it — absence already means the right thing. */
export async function readPhotoRankEnabled(db: Kysely<CoreScanDB>): Promise<boolean> {
  const row = await db
    .selectFrom("core_scan_photo_rank_config")
    .select("enabled")
    .where("id", "=", true)
    .executeTakeFirst()
    .catch(() => undefined);
  return row?.enabled === true;
}

/** Set the workspace opt-in (upsert the singleton). */
export async function writePhotoRankEnabled(db: Kysely<CoreScanDB>, enabled: boolean): Promise<void> {
  await db
    .insertInto("core_scan_photo_rank_config")
    .values({ id: true, enabled, updated_at: new Date() })
    .onConflict((oc) => oc.column("id").doUpdateSet({ enabled, updated_at: new Date() }))
    .execute();
}

/** First non-empty value a candidate filled for `field` (e.g. the resolved
 *  `color`), across the item's candidates. Generic — no vehicle knowledge. */
export function candidateFieldValue(candidates: unknown, field: string): string | null {
  if (!Array.isArray(candidates)) return null;
  for (const c of candidates) {
    const v = (c as { fields?: Record<string, unknown> })?.fields?.[field];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Everything a rank call needs about the item, derived one way for every
 *  surface. `query` is null when there is nothing searchable (a junk name). */
export interface RankContext {
  query: string | null;
  brand: string | null;
  color: string | null;
  category: string | null;
  name: string | null;
  referenceB64: string | null;
  referenceMediaType: string | null;
}

/** What the DERIVATION reads. Deliberately narrower than the guard's row: the
 *  query/colour/category/reference don't depend on the row's status, so the
 *  button (which never checks status) needn't select it. */
export interface RankFacts {
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_candidates: unknown;
  suggested_metadata: Record<string, unknown> | null;
  image_file_id: string | null;
}

/** The row the ALWAYS-ON pass reads: the derivation's facts + the status the
 *  cost guard needs. */
export interface RankRow extends RankFacts, AutoRankRow {}

/** Derive the rank context from a row: the platform-standard image query (name +
 *  brand + the item's own fields), the declared colour, the identify's coarse
 *  category, and the user's own photo as a colour/identity reference. */
export async function deriveRankContext(
  orgId: string,
  row: RankFacts,
  opts?: { queryOverride?: string | null; withReference?: boolean },
): Promise<RankContext> {
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const category =
    (typeof meta.category === "string" && meta.category.trim() ? meta.category.trim() : null) ??
    candidateFieldValue(row.suggested_candidates, "category");
  const color = candidateFieldValue(row.suggested_candidates, "color");
  const cands = (row.suggested_candidates as Array<{ fields?: Record<string, unknown> }> | null) ?? [];
  const candidateFields: Record<string, unknown> = Object.assign(
    {},
    // reverse: earlier (higher-confidence) candidates win on key collisions
    ...cands.map((c) => c.fields ?? {}).reverse(),
    ...(color ? [{ color }] : []),
  );
  const query = deriveImageQuery({
    name: row.suggested_name ?? null,
    brand: row.suggested_manufacturer ?? null,
    fields: candidateFields,
    override: opts?.queryOverride ?? null,
  });

  let referenceB64: string | null = null;
  let referenceMediaType: string | null = null;
  if (opts?.withReference !== false && row.image_file_id) {
    // The medium variant — smaller payload, same as the identify pass.
    const file =
      (await platform().files.read(orgId, row.image_file_id, "medium").catch(() => null)) ??
      (await platform().files.read(orgId, row.image_file_id, "original").catch(() => null));
    if (file) {
      referenceB64 = Buffer.from(file.bytes).toString("base64");
      referenceMediaType = file.mimeType;
    }
  }
  return {
    query,
    brand: row.suggested_manufacturer ?? null,
    color,
    category,
    name: row.suggested_name ?? null,
    referenceB64,
    referenceMediaType,
  };
}

export type AutoRankOutcome =
  | { ranked: false; skipped: string }
  | { ranked: true; url: string; reason: string; rankedOver: number };

/** The ALWAYS-ON pass: rank this row's catalog photo and APPLY the pick.
 *
 *  Fired by the seeded wire on core-scan.scan.enriched when the workspace has
 *  turned the always-on setting on. Every early return is a vision call not
 *  spent (see shouldAutoRank for the per-row rules).
 *
 *  Applies through downloadCatalogImage (bytes into core-files, so the image
 *  survives the external host) and stamps:
 *    catalog_image_ai_ranked_for  — the NAME it ranked for; the repeat guard
 *    catalog_image_ai_reason      — the model's one-liner, shown in the UI
 *  It deliberately does NOT set `catalog_image_user_set`: that lock means "a
 *  human chose this", and claiming it would both lie about provenance and block
 *  the user's own later re-pick from being treated as an override. */
export async function autoRankCatalogPhoto(opts: {
  db: Kysely<CoreScanDB>;
  orgId: string;
  itemId: string;
  userId?: string | null;
}): Promise<AutoRankOutcome> {
  const { db, orgId, itemId } = opts;
  const row = (await db
    .selectFrom("core_scan_inbox_items")
    .select([
      "status",
      "suggested_name",
      "suggested_manufacturer",
      "suggested_candidates",
      "suggested_metadata",
      "image_file_id",
    ])
    .where("id", "=", itemId)
    .executeTakeFirst()) as RankRow | undefined;
  if (!row) return { ranked: false, skipped: "no such row" };
  if (!shouldAutoRank(row, null)) return { ranked: false, skipped: "guard" };

  const ctx = await deriveRankContext(orgId, row);
  if (!ctx.query) return { ranked: false, skipped: "nothing searchable" };

  const pool = await searchImages(ctx.query, 24).catch(() => []);
  const candidates = selectTopCandidates(pool, ctx.brand, ctx.query, IMAGE_BUDGET, ctx.color);
  // One candidate is not a choice — applying it would be the plain heuristic
  // pick at the price of a vision call.
  if (candidates.length < 2) return { ranked: false, skipped: "not enough candidates to choose between" };

  const result = await rankPhotoWithAi({
    orgId,
    userId: opts.userId ?? null,
    itemId,
    itemName: ctx.name ?? ctx.query,
    brand: ctx.brand,
    knownColor: ctx.color,
    category: ctx.category,
    referenceB64: ctx.referenceB64,
    referenceMediaType: ctx.referenceMediaType,
    candidates,
  });
  if (!result) return { ranked: false, skipped: "no pick (no provider, or unreadable candidates)" };

  // Download FIRST: a lot of web-image URLs can't be fetched (hotlink block,
  // 404, non-image), and committing the url anyway is how a row ends up wearing
  // a broken image (the same trap POST /catalog-image documents).
  const stored = await downloadCatalogImage({ db, orgId, itemId }, result.chosenUrl);
  const rankedFor = (ctx.name ?? ctx.query).trim();
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      ...(stored ? { catalog_image_url: result.chosenUrl } : {}),
      // Stamp even when the download failed, so a dead URL isn't retried on
      // every subsequent enrich for the same name.
      suggested_metadata: mergeMeta({
        catalog_image_ai_ranked_for: rankedFor,
        ...(result.reason ? { catalog_image_ai_reason: result.reason } : {}),
      }) as never,
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .execute();
  if (!stored) return { ranked: false, skipped: "chosen image could not be downloaded" };
  return { ranked: true, url: result.chosenUrl, reason: result.reason, rankedOver: result.rankedOver };
}
