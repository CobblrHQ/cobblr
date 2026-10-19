// core-scan:ran-out: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

// UI-SCREEN: /scan  the inbox card's ⋯, the camera's sheet and a station offer Ran out through the confirm and attach routes this action calls (web/src/pages/scanRanOut.ts)
const action: ModuleActionInput = {
  group: "stock",
  id: "core-scan:ran-out",
  changes: "records",
  runBy: "member",
  examples: ["I just ran out of oat milk and I don't have it in Cobblr yet", "Mark the coffee filters I scanned as ran out"],
  label: "Ran out",
  description: "Keeps a scanned thing at none on hand and puts it on the shopping list: a new thing is added at 0, one you already keep is taken to 0 through Used it up, and a restock rule fires as for anything used up. Pass item_id, the scan in the inbox; for a new thing, kind says where it is kept when the scan was not going anywhere yet.",
  scope: "workspace",
  invokeHandler: "core-scan.ran-out",
  userInvokable: true,
  argsSchema: {
    item_id: { label: "The scan in the inbox", type: "text", required: true },
    kind: { label: "Where it is kept, when it is new (a kind, like a table's items); else where the scan was going", type: "text" },
    instance: { label: "The table, when the kind has several", type: "text" },
  },
};

export default action;
