// Feed scan-triage corrections back to the shared Barcode Intelligence DB.
//
// When a barcode item is renamed away from what the resolver returned, the
// human's name is the truth — POST it to the resolver's /correct so the next
// scan of that UPC (in any workspace) gets the fix. Fire-and-forget; inert
// unless COBBLR_BARCODE_RESOLVER_URL + a correction token are set.
//
// The token's TYPE decides trust (resolver-side): a write-token → verified=true
// (instant override, the author's instances); a propose-token → verified=false (review
// queue, cobblr.me public). Both flow through COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN
// here — this side doesn't need to know which. See
// CobblrHQ/barcode-intelligence/docs/correction-feedback.md.

import crypto from "node:crypto";

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** True when `now` is a real, meaningful change from `was` (not blank, not just
 *  whitespace/case). A miss (was=null) that the user named also counts. Pure. */
export function meaningfullyChanged(was: string | null | undefined, now: string | null | undefined): boolean {
  const n = (now ?? "").trim();
  if (!n) return false;
  return norm(was) !== norm(now);
}

/** Opaque per-user actor id (HMAC) — never a username/workspace/PII (doc 13). */
function opaqueActor(userId: string | null | undefined): string | null {
  const secret = process.env.JWT_SECRET ?? "";
  if (!userId || !secret) return null;
  return "u_" + crypto.createHmac("sha256", secret).update(userId).digest("hex").slice(0, 16);
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

export async function reportBarcodeCorrection(opts: {
  upc: string;
  field: "title" | "brand" | "category" | "image_url";
  was: string | null;
  now: string | null;
  userId?: string | null;
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
}): Promise<void> {
  const base = (process.env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  const tok = process.env.COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN ?? "";
  if (!base || !tok) return; // unconfigured → no-op
  if (!/^[0-9]{6,14}$/.test(opts.upc)) return;
  if (!(opts.now ?? "").trim()) return; // never POST a blank value
  // A confirm or a commit-signal both affirm the CURRENT value, so neither needs
  // it to have changed; a plain triage correction must be a real change.
  if (!opts.confirm && !opts.commitSignal && !meaningfullyChanged(opts.was, opts.now)) return;
  try {
    await fetch(`${base}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        upc: opts.upc,
        field: opts.field,
        value: (opts.now ?? "").trim(),
        source_context: opts.confirm ? "scan-confirm" : opts.commitSignal ? "scan-commit" : "scan-triage",
        corrected_by: opaqueActor(opts.userId),
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
  const base = (process.env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  const tok = process.env.COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN ?? "";
  if (!base || !tok) return; // unconfigured → no-op
  if (!/^[0-9]{6,14}$/.test(opts.upc)) return;
  const actor = opaqueOrgActor(opts.orgId);
  if (!actor) return; // an anonymous vote can never form consensus — don't bother
  try {
    await fetch(`${base}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
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
