// core-scan:fill-order-line: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // UI-SCREEN: /scan
  group: "more",
  id: "core-scan:fill-order-line",
  changes: "records",
  runBy: "member",
  examples: ["this spool is one of the ten I ordered", "count that scan toward the Kingroon order"],
  label: "Count a scan as one of an order line's units",
  description:
    "Count a scan in the inbox as ONE unit of an order line of the same thing: the line reads 3 of 10 received, nothing new is created, and the purchase line is received when the last unit is in. A scan counts once, ever. Undo takes it back. Args: { item_id, line_id } (the scan and the inbox order line), or order_item_id in place of line_id.",
  scope: "workspace" as const,
  argsSchema: {
    item_id: { label: "The scan", type: "text", required: true },
    line_id: { label: "The inbox order line", type: "text" },
    order_item_id: { label: "Or the purchase's line", type: "text" },
  },
  invokeHandler: "core-scan.fill-order-line",
  userInvokable: false,
  undoable: true,
};

export default action;
