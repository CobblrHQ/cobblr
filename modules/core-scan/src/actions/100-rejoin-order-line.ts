// core-scan:rejoin-order-line: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // UI-SCREEN: /scan
  group: "more",
  id: "core-scan:rejoin-order-line",
  changes: "records",
  runBy: "member",
  examples: ["put those two back with the rest", "they were white after all, put them back"],
  label: "Put split-off units back into their line",
  description: "Put a line split off an order line back into it: the line takes its units and its price back. Refused once the split-off line is filed. Args: { item_id } (the split-off line).",
  scope: "workspace" as const,
  argsSchema: { item_id: { label: "The split-off line", type: "text", required: true } },
  invokeHandler: "core-scan.rejoin-order-line",
  userInvokable: false,
  // Reached as the undo of its pair; the card has its own door.
  internal: true,
};

export default action;
