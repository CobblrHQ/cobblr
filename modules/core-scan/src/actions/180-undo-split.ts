// core-scan:undo-split: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "stock",
  // UI-SCREEN: /scan (a split piece's card: "Undo split")
  id: "core-scan:undo-split",
  changes: "records",
  runBy: "member",
  examples: ["undo that split, it was one thing"],
  label: "Undo split",
  description: "Put a split photo back as one: the pieces it was split into leave the inbox (kept, never deleted) and the photo comes back as it was. Pass item_id, the group's or any one piece's. Refused while a piece is already filed.",
  scope: "workspace",
  invokeHandler: "core-scan.undo-split",
  userInvokable: true,
  argsSchema: {
    item_id: { label: "The split: the group's id or one piece's", type: "text", required: true },
  },
};

export default action;
