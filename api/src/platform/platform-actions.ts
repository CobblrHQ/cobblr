// The KERNEL's own actions — workspace configuration the platform owns.
//
// Custom fields, module instances and wires are kernel primitives (CLAUDE.md
// §2), so no module can declare actions for them — entity_actions rows are
// seeded from module manifests, and a `core-setup` module to hold these was
// considered and rejected (a junk drawer owning three unrelated kernel
// concepts, with no tables of its own). Instead the kernel declares its own
// actions here, under the RESERVED owner name "platform", and registry-sync
// seeds them through the same array as module actions — same upsert, same
// orphan-cleanup, no special case.
//
// The one-rail rule this preserves: EVERY operation an agent can perform is an
// action on the invoke_action rail. It inherits requireCapability (owner/admin
// pass; a member needs an explicit per-action grant), the in-app Confirm card
// (the chat always proposes invoke_action, even in Changes:auto), and the
// activity ledger. See docs/design-decisions/platform-actions.md.
//
// Handlers live in platform-action-handlers.ts, wired at boot. A unit test
// pins the two files 1:1 — an action declared here without a registered
// handler would fail at invoke time, in front of a user (the exact half-wire
// class lint:dead-exports caught in #1938).

/** The reserved owner. lint-manifests refuses a module named this. */
export const PLATFORM_ACTION_OWNER = "platform";

/** Shape-compatible with the rows registry-sync builds from module manifests. */
export interface PlatformActionDecl {
  id: string;
  label: string;
  description: string;
  icon: string | null;
  scope: "workspace";
  invoke_handler: string;
  user_invokable: boolean;
  args_schema: Record<string, { label: string; type: "text" | "boolean" | "number" }>;
  version: string;
}

export const PLATFORM_ACTIONS: PlatformActionDecl[] = [
  {
    id: "platform:add-field",
    label: "Add a field",
    description:
      "Add a custom field to one kind of record (e.g. inventory:part), or to a whole class of them with a trait scope (e.g. @physical puts it on everything physical). Types: text (choices makes it a dropdown), number (with a unit), date, boolean, relation (needs ref_kind: the kind it points at). Runs on the workspace, not a record. Check the kind's existing fields with list_record_kinds first. Fields cannot be edited or deleted this way, only added.",
    icon: "list-plus",
    scope: "workspace",
    invoke_handler: "platform.add-field",
    user_invokable: true,
    args_schema: {
      entity_kind: { label: "Which kind of record (or a trait scope like @physical)", type: "text" },
      display_label: { label: "The field's label (e.g. Purchase Date)", type: "text" },
      name: { label: "Storage name (lowercase; derived from the label if omitted)", type: "text" },
      type: { label: "text, number, date, boolean, relation (or: dropdown, checkbox)", type: "text" },
      choices: { label: "For a dropdown: the choices, comma-separated", type: "text" },
      unit: { label: "For a number: its unit (mm, g, in)", type: "text" },
      ref_kind: { label: "For a relation: the kind it points at", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:create-instance",
    label: "Create a list (instance)",
    description:
      "Create a separate skinned list from a module the workspace already has — 3D Printers and CNC both from Machines, each with its own nav entry, fields and label codes. Runs on the workspace, not a record. The result names the new list's kind id (e.g. cnc:item) — use that with list_records and create_record. Check what exists with get_workspace_setup (instances) first.",
    icon: "layout-grid",
    scope: "workspace",
    invoke_handler: "platform.create-instance",
    user_invokable: true,
    args_schema: {
      module_name: { label: "The module to make a list from (e.g. machines)", type: "text" },
      display_name: { label: "What to call the list (e.g. CNC Machines)", type: "text" },
      instance_name: { label: "Short name (lowercase; derived from the display name if omitted)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:set-wire-enabled",
    label: "Turn an automation on or off",
    description:
      "Switch one automation (wire) on or off by its id — find the id with get_workspace_setup (automations). Toggling only stops or restarts behavior the user already set up; automations cannot be created or edited this way. Runs on the workspace, not a record.",
    icon: "toggle-left",
    scope: "workspace",
    invoke_handler: "platform.set-wire-enabled",
    user_invokable: true,
    args_schema: {
      wire_id: { label: "The automation's id", type: "text" },
      enabled: { label: "On (true) or off (false)", type: "boolean" },
    },
    version: "0.1.0",
  },
];
