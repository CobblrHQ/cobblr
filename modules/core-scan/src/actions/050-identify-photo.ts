// core-scan:identify-photo: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // NO-PHRASING: the scan pipeline's own step; a person asking to identify something means core-scan:identify
  group: "more",
  id: "core-scan:identify-photo",
  changes: "records",
  runBy: "member",
  label: "Identify a scanned photo",
  description:
    "Vision-identify a photo-only inbox row (no barcode) into a draft. Wire-fired on scan.received; no-ops for barcode/url scans.",
  // DELIBERATELY universal: fires on scan events, not entity sources —
  // the inbox row in the payload is the subject. Kind/trait scoping
  // would be false precision (see /actions provenance).
  appliesTo: { any: true },
  invokeHandler: "core-scan.identify-photo",
  // Wire-only — the autonomous-sort binding fires it, not a button.
  wireOnly: true,
  userInvokable: false,
};

export default action;
