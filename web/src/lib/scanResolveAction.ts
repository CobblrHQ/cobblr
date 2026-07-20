// What a scanned value's resolve outcome should DO on a scan surface, as a pure
// function so it unit-tests without a DOM (same discipline as barcode-wedge.ts).
//
// The component (GlobalScanWedge, and the camera) maps the returned action to
// navigate / show-a-picker / toast / stage-to-inbox. Keeping the decision pure
// means the "resolved navigates, several ask, recognised-but-empty does NOT
// stage, unknown falls through" contract is testable in isolation.

import type { ScanResolveOutcome, ScanResolveCandidate } from "./api";

export type ScanResolveAction =
  | { type: "navigate"; path: string; label: string }
  | { type: "pick"; key: string; candidates: ScanResolveCandidate[]; truncated: boolean }
  | { type: "note"; message: string }
  | { type: "stage" };

/** Decide what to do with a resolve outcome on a scan. `null`/failed resolve is
 *  treated as `stage`, so a resolver hiccup never swallows the scan. */
export function scanResolveActionFor(outcome: ScanResolveOutcome | null): ScanResolveAction {
  if (!outcome) return { type: "stage" };
  switch (outcome.outcome) {
    case "resolved":
      return { type: "navigate", path: outcome.detail_path, label: outcome.entity_label };
    case "ambiguous":
      return {
        type: "pick",
        key: outcome.key,
        candidates: outcome.candidates,
        truncated: outcome.truncated,
      };
    case "recognized_no_match":
      // The format was recognised (a rule or a declared identifier kind) but
      // nothing matched. Intent was declared, so do NOT stage a mystery row.
      return { type: "note", message: `Recognized “${outcome.key}”, but nothing here matches it yet.` };
    case "no_rule":
      // Not a resolver scan at all: the normal product-barcode intake.
      return { type: "stage" };
  }
}
