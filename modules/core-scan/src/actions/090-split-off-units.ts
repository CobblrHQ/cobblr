// core-scan:split-off-units: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // UI-SCREEN: /scan
  group: "more",
  id: "core-scan:split-off-units",
  changes: "records",
  runBy: "member",
  examples: ["two of those ten are black", "split off the 3 that are red"],
  label: "Split the ones that differ off an order line",
  description:
    "On an inbox order line of the same thing, split off the few that differ (\"8 white, 2 black\": count 2, name the black ones) into a line of their own. Both keep their share of the price and their own purchase line. Undo puts them back. Args: { item_id, count, name }.",
  scope: "workspace" as const,
  argsSchema: {
    item_id: { label: "The inbox order line", type: "text", required: true },
    count: { label: "How many differ", type: "number", required: true },
    name: { label: "What they are", type: "text" },
  },
  invokeHandler: "core-scan.split-off-units",
  userInvokable: false,
  undoable: true,
};

export default action;
