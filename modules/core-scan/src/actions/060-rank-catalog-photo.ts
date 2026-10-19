// core-scan:rank-catalog-photo: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // NO-PHRASING: an internal ranking step between enrichment and the draft; there is no sentence for it
  group: "more",
  id: "core-scan:rank-catalog-photo",
  changes: "records",
  runBy: "member",
  label: "Pick the best catalog photo",
  description:
    "Vision-rank an enriched row's candidate photos and set the cleanest catalog shot (product alone, correct colour, no people). Wire-fired on scan.enriched; no-ops unless the workspace turned always-on ranking on, and never over a photo the user picked.",
  // DELIBERATELY universal: fires on scan events, not entity sources —
  // the inbox row in the payload is the subject (same as identify-photo).
  appliesTo: { any: true },
  invokeHandler: "core-scan.rank-catalog-photo",
  // Wire-only. The per-item equivalent is the ✨ Pick best button, which
  // goes through POST /inbox/:id/rank-photo-ai (a press IS the consent).
  wireOnly: true,
  userInvokable: false,
};

export default action;
