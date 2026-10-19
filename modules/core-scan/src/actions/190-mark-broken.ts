// core-scan:mark-broken: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "service",
  // UI-SCREEN: /scan (the Broken mark on a scan that matched a thing you have, card and camera sheet)
  id: "core-scan:mark-broken",
  changes: "records",
  runBy: "member",
  examples: ["the drill I just scanned is broken", "that scan is the sander, it needs repair"],
  label: "Mark broken",
  description: "A scan of a thing you already have, which is broken: opens one repair entry in that thing's service log instead of filing a new thing, and settles the scan. Pass item_id from list_scan_inbox and an optional note (what is wrong). Only a scan that matched one thing by its code or serial number can be marked.",
  scope: "workspace",
  invokeHandler: "core-scan.mark-broken",
  userInvokable: true,
  undoable: true,
  argsSchema: {
    item_id: { label: "The scan", type: "text", required: true },
    note: { label: "What is wrong", type: "text" },
  },
};

export default action;
