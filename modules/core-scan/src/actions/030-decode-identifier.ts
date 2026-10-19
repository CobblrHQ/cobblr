// core-scan:decode-identifier: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "more",
  id: "core-scan:decode-identifier",
  changes: "records",
  runBy: "member",
  examples: ["decode this package label", "read the fields in this identifier"],
  label: "Decode identifier",
  description: "Decode a scanned identifier into its recorded fields. Package labels decode locally; unknown formats return a miss. Args: { code }.",
  scope: "workspace",
  invokeHandler: "core-scan.decode-identifier",
  userInvokable: true,
  argsSchema: { code: { label: "Scanned identifier", type: "text", required: true } },
};

export default action;
