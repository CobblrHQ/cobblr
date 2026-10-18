// Feed scan-triage corrections back to the shared Barcode Intelligence DB.
//
// When a barcode item is renamed away from what the resolver returned, the
// human's name is the truth — POST it to the resolver's /correct so the next
// scan of that UPC (in any workspace) gets the fix. Fire-and-forget; inert
// unless COBBLR_BARCODE_RESOLVER_URL + a correction token are set.
//
// The token's TYPE decides trust (resolver-side): a write-token → verified=true
// (instant override, the author's instances); a propose-token → verified=false (review
// queue, the hosted service public). Both flow through COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN
// here — this side doesn't need to know which. See
// CobblrHQ/barcode-intelligence/docs/correction-feedback.md.

// EGRESS-FILE: operator-configured - the shared barcode database address is the operator's setting
import crypto from "node:crypto";
import { LEARNED_BUNDLE_KEY } from "@cobblr/platform-contract/learned-route";
import { isStockPreviewUrl } from "./stock-preview.js";
import { isStoreCode } from "./barcode-lookup.js";
import { filterToFiled, labelTarget } from "./label-words.js";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { opaqueUserActor } from "@cobblr/platform-contract/photo-retention";

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** True when `now` is a real, meaningful change from `was` (not blank, not just
 *  whitespace/case). A miss (was=null) that the user named also counts. Pure. */
export function meaningfullyChanged(was: string | null | undefined, now: string | null | undefined): boolean {
  const n = (now ?? "").trim();
  if (!n) return false;
  return norm(was) !== norm(now);
}

/** Where a barcode correction/reject POST goes. Prefers a directly-configured box
 *  resolver (`COBBLR_BARCODE_RESOLVER_URL` + its correction token → `/correct`; the
 *  token type decides verified-vs-propose resolver-side); else the hosted BIdb edge
 *  (`COBBLR_BIDB_URL` + the per-install key → `/v1/correct`, which the edge forwards to
 *  the primary as a proposal). The BIdb fallback is what wires the correction flywheel
 *  on a BIdb-only deployment (e.g. `try`, where the resolver URL is unset). */
export function correctionTarget(env: NodeJS.ProcessEnv = process.env): { endpoint: string; token: string } | null {
  const resolver = (env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  const resolverTok = env.COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN ?? "";
  if (resolver && resolverTok) return { endpoint: `${resolver}/correct`, token: resolverTok };
  const bidb = (env.COBBLR_BIDB_URL ?? "").replace(/\/+$/, "");
  const bidbKey = (env.COBBLR_BIDB_KEY ?? "").trim();
  if (bidb && bidbKey) return { endpoint: `${bidb}/v1/correct`, token: bidbKey };
  return null;
}

/** The per-unit facts a scanned unit carries: the lot and the year it was
 *  made read off its label (the row's `lot` and `year_made`), and any value
 *  filed into its lot-role or year-made field. Per unit, so none of them may
 *  ever reach the shared network as a fact about the product: one barcode
 *  covers every dye lot of a yarn and every vintage of a wine. */
export function unitLotsOf(meta: unknown, ...filed: unknown[]): string[] {
  const m = meta as { lot?: unknown; year_made?: unknown } | null;
  const out = [m?.lot, m?.year_made, ...filed]
    .map((v) => (typeof v === "number" && Number.isInteger(v) ? String(v) : v))
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 2)
    .map((v) => v.trim());
  return [...new Set(out)];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with every lot taken out, and the word "lot" that introduced it. */
export function withoutLots(text: string, lots: readonly string[]): string {
  let t = text;
  for (const lot of lots) {
    if (!lot) continue;
    t = t.replace(new RegExp(`(?:\\b(?:dye\\s*)?lot\\s*(?:no\\.?|number|#)?\\s*[:.]?\\s*)?(?<![A-Za-z0-9])${escapeRe(lot)}(?![A-Za-z0-9])`, "gi"), " ");
  }
  return t
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;)])/g, "$1")
    .replace(/([,;])(?:\s*[,;])+/g, "$1")
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
    .trim();
}

/** Opaque per-user actor id (HMAC) — never a username/workspace/PII (doc 13).
 *  The platform unlinks and forgets kept photos by the same id, so the rule
 *  lives in one place. */
function opaqueActor(userId: string | null | undefined): string | null {
  return opaqueUserActor(userId, process.env.JWT_SECRET);
}

/** Opaque per-WORKSPACE actor id — the voter unit for an automatic downvote. The
 *  photo cross-check runs userless (detached), so we vote as the org: one vote per
 *  workspace per UPC, and consensus = distinct WORKSPACES agreeing (the right bar
 *  for "this code is unreliable" — a genuinely-dual UPC never gets suppressed by
 *  one workspace). Never PII. */
function opaqueOrgActor(orgId: string | null | undefined): string | null {
  const secret = process.env.JWT_SECRET ?? "";
  if (!orgId || !secret) return null;
  return "w_" + crypto.createHmac("sha256", secret).update(orgId).digest("hex").slice(0, 16);
}

/** Where a reported value came from (#3769): a catalogue's answer filed as
 *  is, the AI or a web search, or the person typing it. Provenance only. */
export type ValueOrigin = "catalog" | "ai" | "person";

/** The origin of a scanned row's value: the person's when they changed it, the
 *  AI's when the row was named from a photo or a web search, else the
 *  catalogue that answered the barcode. */
export function originOfValue(metaSource: unknown, edited: boolean): ValueOrigin {
  if (edited) return "person";
  return typeof metaSource === "string" && ["web-search", "photo", "vision", "crop"].includes(metaSource) ? "ai" : "catalog";
}

/** A picture address that may leave the workspace: an absolute https URL on
 *  someone else's host, and not a stock agency's preview. Never a link into a workspace's own files (an API or
 *  file-store path, this instance's own address), never data: or blob:. A
 *  person's own photo is kept as a file id and must never be shared by link,
 *  and this is the one gate every picture report passes (#3769). */
export function isShareablePictureUrl(value: string | null | undefined, ownOrigins: readonly string[] = ownInstanceOrigins()): boolean {
  let u: URL;
  try {
    u = new URL(String(value ?? "").trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (/\/api\/|\/modules\/core-files\/|\/files\//i.test(u.pathname)) return false;
  // A stock agency's preview is a watermark, never a catalog picture (#3804).
  if (isStockPreviewUrl(u.href)) return false;
  const host = u.host.toLowerCase();
  return !ownOrigins.some((o) => {
    try {
      return new URL(o).host.toLowerCase() === host;
    } catch {
      return false;
    }
  });
}

function ownInstanceOrigins(): string[] {
  const base = publicBaseUrl();
  return /^https?:\/\//.test(base) ? [base] : [];
}

export async function reportBarcodeCorrection(opts: {
  upc: string;
  field: "title" | "brand" | "category" | "image_url" | `attributes.${string}`;
  was: string | null;
  now: string | null;
  userId?: string | null;
  /** Where the value came from; see ValueOrigin. */
  origin?: ValueOrigin;
  /** A deliberate CONFIRM ("this listing is good — lock it in"): verify the
   *  current value even though it didn't change. Bypasses the changed-guard so a
   *  user affirming a thin/crowdsourced hit promotes it to a verified entry.
   *  Operator-only (see the confirm-barcode route). */
  confirm?: boolean;
  /** A plain scan COMMIT (a user filed a scanned item as-is): a strong SIGNAL the
   *  listing is right, but not fact. Bypasses the changed-guard (report even when
   *  unchanged — the point is confirming the current value), but resolver-side a
   *  `scan-commit` context is a vote that only becomes verified once enough
   *  independent people agree. Distinct from `confirm` (which is absolute). */
  commitSignal?: boolean;
  /** A PHOTO-PROVEN correction (the cross-check read the real product off the
   *  user's own photo): a consensus VOTE like a commit-signal, not an instant
   *  fact and not a dead-end review proposal. The system must converge on the
   *  right answer from these without an operator ever touching the queue. */
  photoCorrect?: boolean;
  /** The reporting WORKSPACE — the voter when no user is in scope (the detached
   *  cross-check). Without an actor a vote can never count toward consensus,
   *  which is how photo corrections piled up as anonymous dead proposals. */
  orgId?: string | null;
  /** The unit's lots (unitLotsOf). Required, so every door to the network says
   *  what it holds: a dye lot is per ball, never a fact about the product. */
  lots: readonly string[];
}): Promise<void> {
  const target = correctionTarget();
  if (!target) return; // no resolver + no BIdb configured → nowhere to send
  if (!/^[0-9]{6,14}$/.test(opts.upc)) return;
  // A shop's own label is meaningful only in that shop: a name somebody gives
  // it is not a fact about a product, and must never reach the shared DB.
  if (isStoreCode(opts.upc)) return;
  const now = opts.field === "image_url" ? (opts.now ?? "") : withoutLots(opts.now ?? "", opts.lots);
  if (!now.trim()) return; // never POST a blank value
  // A picture leaves only as a public catalogue address, never a private link.
  if (opts.field === "image_url" && !isShareablePictureUrl(opts.now)) return;
  // A confirm or a commit-signal both affirm the CURRENT value, so neither needs
  // it to have changed; a photo/triage correction must be a real change.
  if (!opts.confirm && !opts.commitSignal && !meaningfullyChanged(opts.was, now)) return;
  try {
    await fetch(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
      body: JSON.stringify({
        upc: opts.upc,
        field: opts.field,
        value: now.trim(),
        ...(opts.origin ? { origin: opts.origin } : {}),
        source_context: opts.confirm
          ? "scan-confirm"
          : opts.commitSignal
            ? "scan-commit"
            : opts.photoCorrect
              ? "photo-correct"
              : "scan-triage",
        // The user when present, else the workspace — a vote needs SOME stable
        // opaque actor to ever reach consensus.
        corrected_by: opaqueActor(opts.userId) ?? opaqueOrgActor(opts.orgId),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    // Best-effort — a correction never affects the user's own commit.
    console.error("[core-scan] barcode correction report failed:", (err as Error).message);
  }
}

/** Downvote a UPC's provider answer: "the catalog result for this code is wrong."
 *  A negative VOTE, not an assertion — it accrues toward consensus (distinct
 *  workspaces) and only SUPPRESSES the provider facts once enough independent
 *  workspaces agree, so a spam/collided code (a yarn skein resolving to an action
 *  figure, then a reverse-phone site) stops re-serving junk WITHOUT ever
 *  hard-blocking a code that might be legitimately shared. Reversible resolver-side
 *  via review. Fire-and-forget; inert unless the resolver + token are configured. */
export async function reportBarcodeReject(opts: {
  upc: string;
  reason?: string | null;
  /** The scanning workspace — the voter unit (distinct orgs = distinct votes). */
  orgId: string | null;
}): Promise<void> {
  const target = correctionTarget();
  if (!target) return; // no resolver + no BIdb configured → nowhere to send
  if (!/^[0-9]{6,14}$/.test(opts.upc)) return;
  const actor = opaqueOrgActor(opts.orgId);
  if (!actor) return; // an anonymous vote can never form consensus — don't bother
  try {
    await fetch(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
      body: JSON.stringify({
        upc: opts.upc,
        field: "reject",
        value: true,
        reason: opts.reason ?? undefined,
        // The consensus path (same engine as a scan-commit vote): accrue toward a
        // verified suppression once enough DISTINCT workspaces agree.
        source_context: "scan-commit",
        corrected_by: actor,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error("[core-scan] barcode reject report failed:", (err as Error).message);
  }
}

/** A filed product with no barcode, reported by its label's product words
 *  (#3769): only the words also in what the person filed (filterToFiled), the
 *  name, brand and category they settled on, where the name came from, and the
 *  opaque actor. Fire-and-forget; off when no network is configured, when
 *  fewer than three words survive, or when there is no actor (an anonymous
 *  filing never counts, so it is not sent). */
export async function reportLabelConfirm(opts: {
  labelWords: readonly string[];
  name: string;
  brand?: string | null;
  category?: string | null;
  color?: string | null;
  origin: ValueOrigin;
  userId?: string | null;
  /** The unit's lots (unitLotsOf); none of them is ever sent. */
  lots: readonly string[];
}): Promise<void> {
  const target = labelTarget();
  if (!target?.writeToken) return;
  const name = withoutLots(opts.name, opts.lots);
  if (!name) return;
  const brand = opts.brand ? withoutLots(opts.brand, opts.lots) || null : null;
  const lotWords = new Set(opts.lots.flatMap((l) => l.toLowerCase().split(/[^a-z0-9.]+/)).filter(Boolean));
  const words = filterToFiled(
    opts.labelWords.filter((w) => !lotWords.has(w)),
    { name, brand, category: opts.category, color: opts.color },
  ).filter((w) => !lotWords.has(w));
  if (words.length < 3) return;
  const actor = opaqueActor(opts.userId);
  if (!actor) return;
  try {
    await fetch(target.confirm, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.writeToken}` },
      body: JSON.stringify({
        words,
        name,
        ...(brand ? { brand } : {}),
        ...(opts.category ? { category: opts.category } : {}),
        origin: opts.origin,
        corrected_by: actor,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    /* fire-and-forget: a filing is never held up by the network */
  }
}

/** What a filed barcode item is, beyond its name (#3769): the shared table it
 *  went into (a bundle's id) and its product fields, each as a scan-commit
 *  vote, so the next workspace holding the same table files it with no AI.
 *  Only what shareableProductFields lets out (the owner's decision of
 *  2026-10-11: never a lot, serial, price, seller, place, note or free text),
 *  and only alongside a table: a field with nowhere to go teaches nothing. */
export async function reportLearnedRoute(opts: {
  upc: string;
  bundle: string | null;
  fields: Readonly<Record<string, string | number | boolean>>;
  userId?: string | null;
  lots: readonly string[];
  send?: typeof reportBarcodeCorrection;
}): Promise<number> {
  if (!opts.bundle || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(opts.bundle)) return 0;
  const send = opts.send ?? reportBarcodeCorrection;
  const votes: Array<[string, string]> = [[LEARNED_BUNDLE_KEY, opts.bundle], ...Object.entries(opts.fields).map(([k, v]) => [k, String(v)] as [string, string])];
  for (const [key, value] of votes) {
    await send({ upc: opts.upc, field: `attributes.${key}`, was: null, now: value, userId: opts.userId ?? null, commitSignal: true, origin: "person", lots: opts.lots });
  }
  return votes.length;
}
