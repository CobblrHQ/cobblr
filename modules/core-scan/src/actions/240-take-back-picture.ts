// core-scan:take-back-picture: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "lifecycle",
  id: "core-scan:take-back-picture",
  changes: "records",
  runBy: "member",
  examples: ["I uploaded the wrong picture, take it back"],
  label: "Take back a picture",
  description: "Takes back a picture just added to the scan inbox, whether it is still uploading or being read: no row is left in the inbox, and one already made goes to Recently deleted.",
  scope: "workspace",
  invokeHandler: "core-scan.take-back-picture",
  userInvokable: true,
  argsSchema: {
    item_id: { label: "The scan in the inbox", type: "text", oneOf: "which-picture" },
    file_id: { label: "The picture's file, when it has no scan yet", type: "text", oneOf: "which-picture" },
  },
};

export default action;
