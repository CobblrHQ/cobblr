// Scan-drives-screen router (Phase 1). A scan is a DRIVER: it pushes the next
// step to the tab the user designated as driven (reusing the drive hub built for
// AI screen-driving). See docs/design-decisions/scan-drives-screen.md.
//
//   • a Cobblr QR (room / bin / entity label) → navigate the driven tab there;
//   • a product barcode → intake it (the existing /scan) + navigate the driven
//     tab to the Scan inbox so the new row's confirm/intake is on screen;
//   • no designated tab → leave it in the triage inbox (driven:false).

import { qrTokenFromScan } from "@cobblr/platform-contract/qr-token";
import { driveHub } from "./drive-hub.js";
import { resolveQrToken } from "../routes/qr-scan.js";
import { invoke } from "./actions.js";

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

// Re-exported from the contract package, which is the ONE definition shared with
// the browser. Three hand-rolled copies had drifted; two were wrong.
export { qrTokenFromScan } from "@cobblr/platform-contract/qr-token";

/** What a scan does when it lands (D7). `navigate` (the default) drives the
 *  user's designated tab; `print` drops a label for the scanned entity into the
 *  print buffer instead — the accumulate-then-print seam from slice 2. */
export type ScanDisposition = "navigate" | "print";

export interface ScanDriveResult {
  /** True when a designated tab existed and the action was pushed to it. */
  driven: boolean;
  kind: "qr" | "barcode";
  action?: "navigate" | "print";
  path?: string;
  item_id?: string;
  /** For action:"print" — the label was queued (and an auto-flush policy, if
   *  any, evaluated). */
  queued?: boolean;
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
  /** The session's scan mode (D7). Defaults to `navigate`. */
  disposition?: ScanDisposition;
}): Promise<ScanDriveResult> {
  const baseUrl = opts.baseUrl ?? INTERNAL_API;
  const disposition = opts.disposition ?? "navigate";

  // 1. A Cobblr QR (room / bin / item label) → navigate the driven tab there,
  //    OR (print disposition) queue a label for the scanned entity.
  const tok = qrTokenFromScan(opts.code);
  if (tok) {
    const r = await resolveQrToken(tok);
    if (r.ok && r.org_id === opts.orgId) {
      // Print mode: a QR label already points at a real, labelable entity — so
      // scanning one under `print` reprints/accumulates its label rather than
      // navigating. Fires labels:print (which queues + evaluates the user's
      // auto-flush policy). Best-effort: if the entity isn't labelable, fall
      // through to navigate so a scan never dead-ends.
      if (disposition === "print" && r.entity_kind && r.entity_id) {
        try {
          await invoke("labels:print", {
            orgId: opts.orgId,
            userId: opts.userId,
            entity: { kind: r.entity_kind, id: r.entity_id },
            entityKind: r.entity_kind,
            entityId: r.entity_id,
            event: {
              name: null,
              payload: {},
              actor: { user_id: opts.userId, display_name: null, auth_method: "session" },
              timestamp: new Date().toISOString(),
              trigger_type: "user-invoked",
            },
          });
          return { driven: false, kind: "qr", action: "print", item_id: r.entity_id, queued: true };
        } catch (e) {
          console.error("[scan-drive] print disposition failed, navigating instead:", (e as Error).message);
        }
      }
      if (r.detail_path) {
        const driven = driveHub.navigate(opts.userId, opts.orgId, r.detail_path);
        return { driven, kind: "qr", action: "navigate", path: r.detail_path };
      }
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
