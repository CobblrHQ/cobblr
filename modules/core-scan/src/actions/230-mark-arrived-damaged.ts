// core-scan:mark-arrived-damaged: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "stock",
  // UI-SCREEN: /scan (Arrived damaged under More on a scan's card)
  id: "core-scan:mark-arrived-damaged",
  changes: "records",
  runBy: "member",
  examples: ["the thread in this box arrived damaged", "mark that scan as damaged on arrival, the box was crushed"],
  label: "Arrived damaged",
  description: "A scan of something that came in a delivery damaged: settles the scan without adding it to stock, and marks it arrived damaged, with who said so and what is wrong, where the owner reads Recently committed. Pass item_id from list_scan_inbox and an optional note (what is wrong). Undo is the scan's own Undo.",
  scope: "workspace",
  invokeHandler: "core-scan.mark-arrived-damaged",
  userInvokable: true,
  undoable: true,
  argsSchema: {
    item_id: { label: "The scan", type: "text", required: true },
    note: { label: "What is wrong", type: "text" },
  },
};

export default action;
