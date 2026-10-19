// core-scan:set-line-units: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

// An order line's units (#5734): the card's doors (OrderLineUnits),
// for the assistant and the MCP server on the one action rail.
const action: ModuleActionInput = {
  // UI-SCREEN: /scan
  group: "more",
  id: "core-scan:set-line-units",
  changes: "records",
  runBy: "member",
  examples: ["those ten spools are all different colours", "that line is ten of the same"],
  label: "Say an order line is the same or different",
  description:
    "An inbox order line of N (an emailed or uploaded receipt's line) is either N of the SAME thing (one record of N; scans count toward it) or a pack of N DIFFERENT things (it becomes N lines, each matched on its own, each with its share of the price and its own purchase line). mode same on a line split into its parts puts it back as one line. Args: { item_id, mode } (same or different).",
  scope: "workspace" as const,
  argsSchema: {
    item_id: { label: "The inbox order line", type: "text", required: true },
    mode: { label: "same or different", type: "text", required: true },
  },
  invokeHandler: "core-scan.set-line-units",
  userInvokable: false,
  undoable: true,
};

export default action;
