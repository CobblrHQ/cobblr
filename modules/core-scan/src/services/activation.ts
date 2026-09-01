// The one funnel milestone this module owns: somebody captured something.
//
// A scan is the product's promised first success ("point your phone at it"),
// so whether a new workspace ever gets here is the activation question the
// operator console answers. Daily, not per capture: a Live Sort session is one
// fact ("they scanned today"), and the read side only ever asks for the first
// day and how many days.

import { platform } from "@cobblr/platform-contract";

export function noteScanCaptured(orgId: string, userId: string | null | undefined, sourceKind: string): void {
  try {
    platform().telemetry.trackDaily({
      orgId,
      userId: userId ?? null,
      event: "scan_captured",
      detail: { source_kind: sourceKind },
    });
  } catch (err) {
    // Telemetry never fails a capture. A stub platform in a unit test may not
    // carry the seam at all.
    console.error("[core-scan] telemetry threw:", (err as Error).message);
  }
}
