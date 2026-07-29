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

import { platform } from "@cobblr/platform-contract";
import { assertSafeOutboundUrl, isPlaceholderImageUrl } from "./enrich.js";
import { browserImageHeaders } from "./image-fetch-headers.js";
import type { DdgImageResult } from "./ddg-images.js";

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
 *  This function IS the cost story of Phase F, so it is pure and tested
 *  directly rather than living inline in the wire handler. Every "no" is a call
 *  not paid for:
 *
 *  - not `pending` — the user already filed or discarded it; a display photo for
 *    a dealt-with row is worth nothing.
 *  - the user picked the catalog image (`catalog_image_user_set`) — a human's
 *    choice is never overridden by an automation, at any price.
 *  - already auto-ranked FOR THIS NAME (`catalog_image_ai_ranked_for`) — the
 *    trigger event (`scan.enriched`) also fires on a re-run, and re-paying to
 *    re-answer the same question is the obvious runaway. Keyed on the resolved
 *    name, not a bare boolean, so a re-run that genuinely re-identifies the item
 *    ("tool bag" → "Bluetooth speaker") DOES get a fresh pick: that is a
 *    different question, not a repeat.
 *  - no usable name — the query derivation would return null anyway, so the call
 *    could only rank photos of nothing.
 *
 *  The workspace toggle and the AI kill-switch / credit gate are checked
 *  elsewhere (the setting before this, core-ai's entitlement guard after);
 *  this is only the per-ROW question. */
export function shouldAutoRank(row: AutoRankRow, resolvedName: string | null): boolean {
  if ((row.status ?? "pending") !== "pending") return false;
  const meta = row.suggested_metadata ?? {};
  if (meta.catalog_image_user_set === true) return false;
  const name = (resolvedName ?? row.suggested_name ?? "").trim();
  if (!name) return false;
  const rankedFor = typeof meta.catalog_image_ai_ranked_for === "string" ? meta.catalog_image_ai_ranked_for : null;
  if (rankedFor && rankedFor.toLowerCase() === name.toLowerCase()) return false;
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

/** Parse the model's JSON pick and MAP it to a candidate index (0-based into the
 *  candidate array actually shown), clamping to range. Returns null when the
 *  reply is unusable.
 *
 *  The whole off-by-one lives HERE, tested directly, so a prompt or wiring
 *  change can't silently pick the wrong tile. `hasReference` means the model saw
 *  a reference photo as image 0, so its `chosen_index` is into the FULL list and
 *  candidates start at 1 — we subtract the offset. A value that lands on the
 *  reference (or below) is invalid; fall back to the top candidate, never the
 *  reference (which is the user's own dark photo — the thing we're replacing). */
export function parseRankReply(
  raw: string,
  opts: { candidateCount: number; hasReference: boolean },
): { candidateIndex: number; reason: string; colorSeen: string | null } | null {
  if (opts.candidateCount <= 0) return null;
  let parsed: Record<string, unknown>;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawIdx = parsed.chosen_index;
  const n = typeof rawIdx === "number" ? rawIdx : Number(rawIdx);
  if (!Number.isFinite(n)) return null;
  const offset = opts.hasReference ? 1 : 0;
  let candidateIndex = Math.round(n) - offset;
  if (candidateIndex < 0) candidateIndex = 0;
  if (candidateIndex > opts.candidateCount - 1) candidateIndex = opts.candidateCount - 1;
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  const colorSeen =
    typeof parsed.color_seen === "string" && parsed.color_seen.trim() ? parsed.color_seen.trim() : null;
  return { candidateIndex, reason, colorSeen };
}

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
}): Promise<RankPhotoResult | null> {
  const hasReference = !!opts.referenceB64;
  // Fetch the candidate thumbnails concurrently; drop any that won't load so the
  // indices the model sees line up exactly with `usable`.
  const fetched = await Promise.all(
    opts.candidates.map(async (c) => ({ c, img: await fetchImageBase64(c.thumb || c.url) })),
  );
  const usable = fetched.flatMap((x) => (x.img ? [{ c: x.c, img: x.img }] : []));
  if (usable.length === 0) return null;

  const images: Array<{ image_b64: string; image_media_type: string }> = [];
  if (hasReference) {
    images.push({ image_b64: opts.referenceB64!, image_media_type: opts.referenceMediaType || "image/jpeg" });
  }
  for (const u of usable) images.push({ image_b64: u.img.b64, image_media_type: u.img.mediaType });

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
        has_reference: hasReference,
        images,
      },
      source: { kind: "core-scan:rank-images", id: opts.itemId },
      userId: opts.userId ?? undefined,
      bypass_cache: opts.bypassCache,
    });
    const res = r.result as { text?: string; content?: string };
    raw = res.text ?? res.content ?? "";
  } catch (err) {
    console.error("[core-scan] rank-images failed:", (err as Error).message);
    return null;
  }

  const parsed = parseRankReply(raw, { candidateCount: usable.length, hasReference });
  if (!parsed) return null;
  const chosen = usable[parsed.candidateIndex]?.c ?? usable[0]!.c;
  return {
    chosenUrl: chosen.url,
    reason: parsed.reason,
    colorSeen: parsed.colorSeen,
    rankedOver: usable.length,
  };
}
