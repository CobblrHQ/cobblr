// AI multi-image re-rank of the catalog-photo candidates. Shown the SAME pool
// the heuristic (rankImageOptions) already ranked, a vision model picks the best
// CATALOG shot by the author's priorities: product ALONE (no people/tags), correct
// COLOUR, clean studio look. The heuristic is still the instant, free floor and
// the ORDER we send the candidates in; this only re-picks among the top few by
// LOOKING at the pixels — the only way to enforce "no human in frame" and the
// true colour, which a title never reveals.
//
// Read-only: it returns the AI's chosen URL + reason. Applying it as the catalog
// image goes through the existing POST /inbox/:id/catalog-image path (the one
// that stashes the original + sets the user lock), so there's one apply surface.
//
// The candidates are composed into ONE numbered contact sheet (contact-sheet.ts)
// rather than sent as N attachments: a fraction of the image tokens, and it uses
// the same single-image plumbing every provider adapter already has, instead of
// multi-image support that three of the five lacked.

import { platform } from "@cobblr/platform-contract";
import { assertSafeOutboundUrl, isPlaceholderImageUrl } from "./enrich.js";
import { browserImageHeaders } from "./image-fetch-headers.js";
import type { DdgImageResult } from "./ddg-images.js";
import { composeContactSheet } from "./contact-sheet.js";

// A candidate is a THUMBNAIL — a few tens of KB. Anything larger isn't a thumb
// (a full-res hero, a mis-typed URL); skip it rather than send megabytes to the
// model. 1 MB is already ~10x a real DDG thumb; worst case is candidates+1
// images per call, so this also bounds the total provider payload.
const MAX_BYTES = 1 * 1024 * 1024;

/** The row facts the auto-rank guard reads. */
export interface AutoRankRow {
  status: string | null;
  suggested_name: string | null;
  suggested_metadata: Record<string, unknown> | null;
}

/** Should the ALWAYS-ON pass spend a vision call on this row?
 *
 *  This function IS the cost story, so it is pure and tested directly rather
 *  than living inline in the wire handler. Every "no" is a call not paid for:
 *
 *  - not `pending` — the user already filed or discarded it; a display photo for
 *    a dealt-with row is worth nothing.
 *  - the user picked the catalog image (`catalog_image_user_set`) — a human's
 *    choice is never overridden by an automation, at any price.
 *  - we already ranked FOR THIS QUESTION (`catalog_image_ai_ranked_for`) — the
 *    trigger event also fires on a re-run, and re-paying to re-answer the same
 *    question is the obvious runaway.
 *  - no question to ask (a junk/blank name derives no query).
 *
 *  The repeat guard keys on the derived QUERY, not the name. The query is what
 *  the pick actually depends on — name, brand, and the resolved colour — so:
 *  re-running with a new hint ("color: black") changes the query and DOES earn a
 *  fresh pick even though the name is identical, while a re-run that changes
 *  nothing is free. Keying on the name alone got that backwards: the exact case
 *  a person re-runs FOR (correcting the colour) was the one it skipped (the author,
 *  2026-07-30).
 *
 *  The workspace toggle and the AI kill-switch / credit gate are checked
 *  elsewhere (the setting before this, core-ai's entitlement guard after);
 *  this is only the per-ROW question. */
export function shouldAutoRank(row: AutoRankRow, askedQuery: string | null): boolean {
  if ((row.status ?? "pending") !== "pending") return false;
  const meta = row.suggested_metadata ?? {};
  if (meta.catalog_image_user_set === true) return false;
  const asked = (askedQuery ?? "").trim();
  if (!asked) return false;
  const rankedFor = typeof meta.catalog_image_ai_ranked_for === "string" ? meta.catalog_image_ai_ranked_for : null;
  if (rankedFor && rankedFor.toLowerCase() === asked.toLowerCase()) return false;
  return true;
}

/** Fetch one image URL → base64 + mime, or null (unsafe target, placeholder,
 *  too big, blocked, or a non-image). Guarded: a web-search result URL is
 *  attacker-influenceable, so it goes through the SSRF check, never plain. */
export async function fetchImageBase64(url: string): Promise<{ b64: string; mediaType: string } | null> {
  if (!url || isPlaceholderImageUrl(url)) return null;
  try {
    assertSafeOutboundUrl(url);
  } catch {
    return null;
  }
  try {
    const res = await fetch(url, { headers: browserImageHeaders(url), signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    const blob = await res.blob();
    if (blob.size === 0 || blob.size > MAX_BYTES) return null;
    const mediaType = blob.type || "image/jpeg";
    if (!mediaType.startsWith("image/")) return null;
    const b64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
    return { b64, mediaType };
  } catch {
    return null;
  }
}

/** Parse the model's JSON pick and map the TILE NUMBER (1-based, as printed on
 *  the sheet) to a candidate index (0-based), clamping to range. Returns null
 *  when the reply is unusable.
 *
 *  The whole off-by-one lives HERE, tested directly, so a prompt or layout
 *  change can't silently pick the wrong photo. Tiles are 1-based because that is
 *  what a person (and a model) reads off a numbered sheet; the user's own photo
 *  is an UNNUMBERED strip, so unlike the old multi-attachment shape there is no
 *  "index 0 is the reference" hazard to guard against at all.
 *
 *  Tolerates `chosen_index` as a legacy alias for replies produced by a cached
 *  older prompt, and a numeric string. */
export function parseRankReply(
  raw: string,
  opts: { tileCount: number },
): { candidateIndex: number; reason: string; colorSeen: string | null } | null {
  if (opts.tileCount <= 0) return null;
  let parsed: Record<string, unknown>;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawTile = parsed.chosen_tile ?? parsed.chosen_index;
  const n = typeof rawTile === "number" ? rawTile : Number(rawTile);
  if (!Number.isFinite(n)) return null;
  let candidateIndex = Math.round(n) - 1; // tiles are 1-based
  if (candidateIndex < 0) candidateIndex = 0;
  if (candidateIndex > opts.tileCount - 1) candidateIndex = opts.tileCount - 1;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  const colorSeen =
    typeof parsed.color_seen === "string" && parsed.color_seen.trim() ? parsed.color_seen.trim() : null;
  return { candidateIndex, reason, colorSeen };
}

/** Why a rank produced no pick — each maps to a DIFFERENT thing the user can do
 *  about it, which is why the endpoint no longer reports one catch-all message. */
export type RankFailure = "no-provider" | "unreadable" | "model";

export interface RankPhotoResult {
  /** The candidate URL the model chose (to apply as the catalog image). */
  chosenUrl: string;
  /** One short sentence on why — surfaced to the user. */
  reason: string;
  /** The colour the model reports for its pick (or null). */
  colorSeen: string | null;
  /** How many candidates it actually ranked over (after unfetchable ones drop). */
  rankedOver: number;
}

/** A pick, or the reason there isn't one. */
export type RankPhotoOutcome = RankPhotoResult | { error: RankFailure };

export function isRankFailure(o: RankPhotoOutcome | null): o is { error: RankFailure } {
  return !!o && "error" in o;
}

/** Ask the vision model to pick the best catalog photo among `candidates` (the
 *  heuristic-ranked pool, already sliced to the image budget). Returns null when
 *  nothing is rankable (no provider, no fetchable candidate, model error). */
export async function rankPhotoWithAi(opts: {
  orgId: string;
  userId?: string | null;
  itemId: string;
  itemName: string;
  brand: string | null;
  knownColor: string | null;
  /** The identify's coarse category — sharpens the rank prompt per kind
   *  (apparel vs packaged good vs media). See categoryGuidance. */
  category?: string | null;
  /** The user's own photo, base64 — a colour/identity REFERENCE, never a pick. */
  referenceB64?: string | null;
  referenceMediaType?: string | null;
  candidates: DdgImageResult[];
  bypassCache?: boolean;
}): Promise<RankPhotoOutcome> {
  const hasReference = !!opts.referenceB64;
  // Fetch the candidate thumbnails concurrently; drop any that won't load so the
  // tiles the model sees line up exactly with `usable`.
  const fetched = await Promise.all(
    opts.candidates.map(async (c) => ({ c, img: await fetchImageBase64(c.thumb || c.url) })),
  );
  const usable = fetched.flatMap((x) => (x.img ? [{ c: x.c, img: x.img }] : []));
  if (usable.length === 0) return { error: "unreadable" };

  // ONE image: the numbered contact sheet. Its tile order IS `usable`'s order,
  // which is what makes the model's tile number a candidate index.
  const sheet = await composeContactSheet({
    candidates: usable.map((u) => ({ b64: u.img.b64, mediaType: u.img.mediaType })),
    reference: opts.referenceB64 ? { b64: opts.referenceB64, mediaType: opts.referenceMediaType ?? undefined } : null,
  });
  if (!sheet) return { error: "unreadable" };

  let raw = "";
  try {
    const r = await platform().ai.invoke({
      orgId: opts.orgId,
      capability: "rank-images",
      input: {
        item_name: opts.itemName,
        ...(opts.brand ? { brand: opts.brand } : {}),
        ...(opts.knownColor ? { known_color: opts.knownColor } : {}),
        ...(opts.category ? { category: opts.category } : {}),
        // The sheet's shape, so the prompt can describe exactly what the model
        // is looking at (and so the cache key moves when the shape does).
        tiles: sheet.tiles,
        cols: sheet.cols,
        has_reference: sheet.hasReference,
        image_b64: sheet.b64,
        image_media_type: sheet.mediaType,
      },
      source: { kind: "core-scan:rank-images", id: opts.itemId },
      userId: opts.userId ?? undefined,
      bypass_cache: opts.bypassCache,
    });
    const res = r.result as { text?: string; content?: string };
    raw = res.text ?? res.content ?? "";
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error("[core-scan] rank-images failed:", msg);
    // The "no provider" family (no provider configured / not entitled / AI
    // disabled for the instance) is a CONFIGURATION answer the user can act on,
    // and must not be reported as the same thing as a model or network failure.
    return { error: /no provider|not entitled|disabled for this instance/i.test(msg) ? "no-provider" : "model" };
  }

  const parsed = parseRankReply(raw, { tileCount: usable.length });
  if (!parsed) return { error: "model" };
  const chosen = usable[parsed.candidateIndex]?.c ?? usable[0]!.c;
  return {
    chosenUrl: chosen.url,
    reason: parsed.reason,
    colorSeen: parsed.colorSeen,
    rankedOver: usable.length,
  };
}
