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

export async function reportBarcodeCorrection(opts: {
  upc: string;
  field: "title" | "brand" | "category" | "image_url";
  was: string | null;
  now: string | null;
  userId?: string | null;
  /** A deliberate CONFIRM ("this listing is good — lock it in"): verify the
   *  current value even though it didn't change. Bypasses the changed-guard so a
   *  user affirming a thin/crowdsourced hit promotes it to a verified entry. */
  confirm?: boolean;
}): Promise<void> {
  const base = (process.env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  const tok = process.env.COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN ?? "";
  if (!base || !tok) return; // unconfigured → no-op
  if (!/^[0-9]{6,14}$/.test(opts.upc)) return;
  if (!(opts.now ?? "").trim()) return; // never POST a blank value
  if (!opts.confirm && !meaningfullyChanged(opts.was, opts.now)) return;
  try {
    await fetch(`${base}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        upc: opts.upc,
        field: opts.field,
        value: (opts.now ?? "").trim(),
        source_context: opts.confirm ? "scan-confirm" : "scan-triage",
        corrected_by: opaqueActor(opts.userId),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    // Best-effort — a correction never affects the user's own commit.
    console.error("[core-scan] barcode correction report failed:", (err as Error).message);
  }
}
