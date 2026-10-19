// core-scan:renewal-draft: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // UI-SCREEN: /instances/:name
  group: "buy", id: "core-scan:renewal-draft", changes: "records", label: "Draft from a receipt", scope: "workspace", invokeHandler: "core-scan.renewal-draft",
  runBy: "member",
  description: "Read a receipt file or forwarded receipt inbox item into a reviewable renewal draft. Pass target_kind and binding matching the collection's receipt_draft configuration, plus file_id or inbox_id. Nothing is filed until the person saves the draft with create_record.",
  argsSchema: { target_kind: { type: "text", label: "Collection", required: true }, file_id: { type: "text", label: "Receipt file" }, inbox_id: { type: "text", label: "Forwarded receipt" }, binding: { type: "json", label: "Receipt field mapping", required: true } },
};

export default action;
