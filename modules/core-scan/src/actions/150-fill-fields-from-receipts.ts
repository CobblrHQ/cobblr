// core-scan:fill-fields-from-receipts: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "organise",
  // UI-SCREEN: /fields (fill empty provenance from past receipts)
  id: "core-scan:fill-fields-from-receipts",
  changes: "records",
  // ADMIN-ONLY: the page's own route POST /receipts/backfill-fields gates on this action's own id, owner or admin (inbox.ts)
  runBy: "admin",
  examples: [
    "fill in where my things came from",
    "backfill provenance from my receipts",
  ],
  label: "Fill fields from past receipts",
  description:
    "Move what already-scanned receipts established (the date printed on them, the shop, a reconciled price) into the fields this workspace has NOW - for items filed before those fields existed. Never overwrites a value that is already there; only fills empty ones. Args: { dry_run? }.",
  // A WORKSPACE sweep, not a record operation: it moves what receipts
  // established into whichever fields the workspace has now, across every
  // kind at once. Declared entity-scoped it rendered a button on every
  // record in the app - on a location called "Rack 1" it sat in the
  // header offering to do something that has nothing to do with Rack 1
  // (2026-08-23). Workspace scope keeps it on the same invoke_action
  // rail, so Cobb and MCP still reach it; it just stops pretending to be
  // about whatever record you are looking at.
  scope: "workspace" as const,
  argsSchema: {
    dry_run: {
      label: "Report what would be filled without writing anything",
      type: "boolean",
    },
  },
  invokeHandler: "core-scan.fill-fields-from-receipts",
  userInvokable: true,
};

export default action;
