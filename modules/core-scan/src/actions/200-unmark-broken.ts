// core-scan:unmark-broken: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "service",
  // UI-SCREEN: /scan (Undo on a scan marked broken)
  id: "core-scan:unmark-broken",
  changes: "records",
  runBy: "member",
  examples: ["it isn't broken after all", "undo marking that broken"],
  label: "Not broken after all",
  description: "Take back Mark broken or Arrived damaged: a repair entry comes off the thing's service log, a damaged mark comes off the scan, and the scan is back in the inbox. Pass item_id, the scan that was marked.",
  scope: "workspace",
  invokeHandler: "core-scan.unmark-broken",
  userInvokable: true,
  argsSchema: {
    item_id: { label: "The scan", type: "text", required: true },
  },
};

export default action;
