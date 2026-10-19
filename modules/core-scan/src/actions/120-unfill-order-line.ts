// core-scan:unfill-order-line: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // UI-SCREEN: /scan
  group: "more",
  id: "core-scan:unfill-order-line",
  changes: "records",
  runBy: "member",
  examples: ["that scan wasn't one of the ten", "take that last spool off the order"],
  label: "Take a scan off its order line",
  description: "The scan was not one of the line's units after all: its slot is free and the scan is back in the inbox. Args: { item_id } (the scan).",
  scope: "workspace" as const,
  argsSchema: { item_id: { label: "The scan", type: "text", required: true } },
  invokeHandler: "core-scan.unfill-order-line",
  userInvokable: false,
  // Reached as the undo of its pair; the card has its own door.
  internal: true,
};

export default action;
