// core-scan:put-back-main-photo: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // NO-PHRASING: the way back for another action, run only from Undo
  group: "lifecycle",
  id: "core-scan:put-back-main-photo", // ACTION-TEMPLATE: undo-only, run from the Undo issued to whoever changed the photo; nobody asks for it in a sentence, so it has no example
  changes: "records",
  runBy: "member",
  internal: true,
  label: "Put back a record's old photo",
  description: "Internal, the inverse of making a picture a record's main photo: puts the photo it had back, only while the record still shows the one that change set. Runs from the Undo issued to the person who changed it; not for direct use.",
  icon: "undo",
  scope: "workspace",
  userInvokable: false,
  invokeHandler: "core-scan.put-back-main-photo",
  argsSchema: {
    entity_kind: { label: "The record's kind", type: "text", required: true },
    entity_id: { label: "The record", type: "text", required: true },
    instance: { label: "The collection it is in, when it is in one", type: "text" },
    made: { label: "The photo the change set", type: "text", required: true },
    previous: { label: "The photo it had before, none when it had none", type: "text" },
  },
};

export default action;
