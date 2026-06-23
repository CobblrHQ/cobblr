// Scan-drives-screen router (Phase 1). A scan is a DRIVER: it pushes the next
// step to the tab the user designated as driven (reusing the drive hub built for
// AI screen-driving). See docs/design-decisions/scan-drives-screen.md.
//
//   • a Cobblr QR (room / bin / entity label) → navigate the driven tab there;
//   • a product barcode → intake it (the existing /scan) + navigate the driven
//     tab to the Scan inbox so the new row's confirm/intake is on screen;
//   • no designated tab → leave it in the triage inbox (driven:false).

import { driveHub } from "./drive-hub.js";
import { resolveQrToken } from "../routes/qr-scan.js";

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

/** Pull a QR token slug out of a scanned payload — a bare token, or the
 *  `…/qr/:token` URL a phone camera reads off a printed Cobblr label. */
export function qrTokenFromScan(code: string): string | null {
  const t = code.trim();
  // Everything after /qr/ — a single opaque segment OR a descriptive
  // "<kind>/<id>" with a slash; stop at any query/fragment, drop a trailing /.
  const m = t.match(/\/qr\/([^?#\s]+)/);
  if (m) return m[1]!.replace(/\/$/, "");
  // A bare token is a url-safe slug with no scheme/space (descriptive bare
  // tokens carry one slash). Numeric-only is a UPC/EAN — let it fall to barcode.
  if (/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.test(t) && t.length >= 6 && /[A-Za-z_-]/.test(t)) return t;
  return null;
}

export interface ScanDriveResult {
  /** True when a designated tab existed and the action was pushed to it. */
  driven: boolean;
  kind: "qr" | "barcode";
  action?: "navigate";
  path?: string;
  item_id?: string;
}

export async function routeScanToDrive(opts: {
  orgId: string;
  orgSlug: string;
  userId: string;
  code: string;
  /** Caller's bearer — for the loopback barcode intake. */
  token: string;
  /** Scoping id so a hands-free scan session lands in one batch (parity with
   *  the Scan page's wedge). Forwarded to the barcode intake; ignored for QR. */
  scanBatchId?: string;
  baseUrl?: string;
}): Promise<ScanDriveResult> {
  const baseUrl = opts.baseUrl ?? INTERNAL_API;

  // 1. A Cobblr QR (room / bin / item label) → navigate the driven tab there.
  const tok = qrTokenFromScan(opts.code);
  if (tok) {
    const r = await resolveQrToken(tok);
    if (r.ok && r.org_id === opts.orgId && r.detail_path) {
      const driven = driveHub.navigate(opts.userId, opts.orgId, r.detail_path);
      return { driven, kind: "qr", action: "navigate", path: r.detail_path };
    }
    // Not a (this-workspace) token → fall through to the barcode path.
  }

  // 2. A product barcode → intake via the existing /scan, then surface the inbox.
  let itemId: string | undefined;
  try {
    const res = await fetch(`${baseUrl}/api/v1/orgs/${opts.orgSlug}/modules/core-scan/scan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        barcode: opts.code,
        source_kind: "barcode",
        ...(opts.scanBatchId ? { scan_batch_id: opts.scanBatchId } : {}),
      }),
    });
    if (res.ok) itemId = ((await res.json()) as { id?: string }).id;
  } catch {
    /* intake is best-effort — a tab still gets driven to the inbox */
  }

  const path = "/scan"; // the Scan inbox: the new row is here, ready to confirm
  const driven = driveHub.navigate(opts.userId, opts.orgId, path);
  return {
    driven,
    kind: "barcode",
    ...(driven ? { action: "navigate" as const, path } : {}),
    ...(itemId ? { item_id: itemId } : {}),
  };
}
