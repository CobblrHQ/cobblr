// core-scan:redo-split: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "stock",
  // UI-SCREEN: /scan (the Undo split toast's "Split again")
  id: "core-scan:redo-split",
  changes: "records",
  runBy: "member",
  examples: ["put that split back", "I didn't mean to undo the split"],
  label: "Split again",
  description: "Put back a split that Undo split took apart: the same parts come back into the inbox as they were, and the line goes back under them. Pass item_id, the line that was put back as one. Refused once that line was filed or split again.",
  scope: "workspace",
  invokeHandler: "core-scan.redo-split",
  userInvokable: true,
  argsSchema: {
    item_id: { label: "The line that was put back as one", type: "text", required: true },
  },
};

export default action;
