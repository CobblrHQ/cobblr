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

import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

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
  /** Can a mistaken run be put right inside the workspace? See EntityAction's
   *  `undoable` in the contract — this is the same decision, for the kernel's
   *  own actions, and it is deliberately not optional here. */
  undoable: boolean;
  /** How a person asks for it. See EntityAction.examples in the contract. */
  examples?: string[];
  /**
   * The floor a caller must clear to invoke this action, declared EXPLICITLY for
   * every platform action (no default) so a new one cannot silently ship without
   * the decision having been made:
   *
   *   • a role rung ("owner", "admin", …) — a HARD floor, rank-based, that NO
   *     capability grant overrides. Use this when the REST twin is stricter than
   *     "owner/admin or a grant" — e.g. `platform:rename-workspace` is hard
   *     `role === "owner"` over REST (PATCH /orgs/:slug), so it is "owner" here.
   *   • "grantable" — no hard floor: the invoke route's default gate governs
   *     (`requireCapability` — owner/admin pass, a member needs an explicit
   *     grant). Use this when the REST twin is `requireRole("owner","admin")` and
   *     the fine-grained grant is intended (all the field/instance/module/config
   *     actions).
   *
   * THE BUG THIS EXISTS FOR (audit M-ACTION-PARITY). The action rail only ran
   * `requireCapability`, which passes any admin, so an admin who could not rename
   * the workspace in Settings could rename it through Cobb / the generic invoke.
   * A rung floor makes the invoke route enforce the SAME gate as the REST twin.
   * Making the field REQUIRED (this is the strengthening over the original) means
   * `lint:action-role-parity` can pin every platform action to an explicit,
   * reviewed floor rather than pattern-matching the description wording — a future
   * owner-only action whose prose omits "owner only" can no longer slip through.
   */
  min_role: OrgRoleName | "grantable";
  args_schema: Record<string, { label: string; type: "text" | "boolean" | "number" }>;
  version: string;
}

export const PLATFORM_ACTIONS: PlatformActionDecl[] = [
  {
    id: "platform:add-field",
    min_role: "grantable",
    label: "Add a field",
    description:
      "Add a custom field to one kind of record (e.g. inventory:part), or to a whole class of them with a trait scope (e.g. @physical puts it on everything physical). Types: text (choices makes it a dropdown), number (with a unit), date, boolean, relation (needs ref_kind: the kind it points at). Runs on the workspace, not a record. Check the kind's existing fields with list_record_kinds first. Fields cannot be edited or deleted this way, only added.",
    icon: "list-plus",
    scope: "workspace",
    invoke_handler: "platform.add-field",
    user_invokable: true,
    // a field cannot be removed by this rail (its own description says added-only), so a wrong one stays
    undoable: false,
    examples: ["add a Purchase Date field to parts", "track a colour on every physical thing"],
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
    id: "platform:edit-field",
    min_role: "grantable",
    label: "Change a field",
    description:
      "Change a field that already exists on a kind of record: rename its label, hide it from forms and lists (or show it again), make it required, or replace the choices of a dropdown. Works on the workspace's own fields AND on the ones a module ships (a part's manufacturer, a machine's serial number), of which the label, whether it shows, and its choices are yours to set. Name the field the way it appears on the form. Runs on the workspace, not a record. What it CANNOT do is change a field's type or its storage name, because values already recorded are stored under both.",
    icon: "pencil",
    scope: "workspace",
    invoke_handler: "platform.edit-field",
    user_invokable: true,
    // every change it makes is one a second call puts back: the old label, the
    // old choices, required off again. Nothing recorded is touched.
    undoable: true,
    examples: [
      "rename the Colour field to Shade",
      "make Purchase Date required on parts",
      "hide the manufacturer field, I don't use it",
      "add Aran to the yarn weight choices",
    ],
    args_schema: {
      entity_kind: { label: "Which kind of record the field is on (e.g. inventory:part)", type: "text" },
      field: { label: "The field, by the label shown on the form (e.g. Purchase Date)", type: "text" },
      display_label: { label: "New label for it", type: "text" },
      required: { label: "Whether it must be filled in", type: "boolean" },
      choices: { label: "For a dropdown: the full list of choices, comma-separated (replaces what is there)", type: "text" },
      unit: { label: "For a number: its unit (mm, g, in)", type: "text" },
      hidden: { label: "True to take it off forms and lists, false to show it again", type: "boolean" },
    },
    version: "0.2.0",
  },
  {
    id: "platform:remove-field",
    min_role: "grantable",
    label: "Remove a field",
    description:
      "Take a custom field off a kind of record. The field stops appearing on forms and lists. Anything already recorded in it is left alone, so adding a field with the same storage name back brings those values into view again. Runs on the workspace, not a record.",
    icon: "list-minus",
    scope: "workspace",
    invoke_handler: "platform.remove-field",
    user_invokable: true,
    // adding it back restores the values, but not the field's own setup — its
    // choices, unit, role and position are gone, and nobody remembers those.
    undoable: false,
    examples: ["remove the Colour field from parts", "I don't want to track shelf life any more"],
    args_schema: {
      entity_kind: { label: "Which kind of record the field is on (e.g. inventory:part)", type: "text" },
      field: { label: "The field, by the label shown on the form (e.g. Shelf Life)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:group-fields",
    min_role: "grantable",
    label: "Group fields under a heading",
    description:
      "Put custom fields under a named heading on a kind's form, creating the heading if it does not exist yet. Name the fields the way they appear on the form; the order you name them is the order they get. Pass rename_to instead of fields to RENAME a heading that is already there. Runs on the workspace, not a record. Fields that apply to a whole class of records cannot be grouped this way, since their layout is not one kind's to set.",
    icon: "rows-3",
    scope: "workspace",
    invoke_handler: "platform.group-fields",
    user_invokable: true,
    // layout only: nothing recorded moves, and ungrouping puts it back
    undoable: true,
    examples: [
      "put purchase date and supplier under Buying",
      "group the size fields together",
      "rename the Buying heading to Purchasing",
    ],
    args_schema: {
      entity_kind: { label: "Which kind of record (e.g. inventory:part)", type: "text" },
      section: { label: "The heading to put them under (e.g. Buying)", type: "text" },
      fields: { label: "The fields, comma-separated, by their labels on the form", type: "text" },
      rename_to: { label: "To RENAME the heading instead: what to call it now", type: "text" },
    },
    version: "0.2.0",
  },
  {
    id: "platform:ungroup-fields",
    min_role: "grantable",
    label: "Take fields out of a heading",
    description:
      "Take custom fields back out of whatever heading they sit under on a kind's form; they return to the ungrouped list. A heading left empty is removed with them. Runs on the workspace, not a record.",
    icon: "rows-2",
    scope: "workspace",
    invoke_handler: "platform.ungroup-fields",
    user_invokable: true,
    // layout only, and grouping them again is the undo
    undoable: true,
    examples: ["take supplier out of Buying", "ungroup the size fields"],
    args_schema: {
      entity_kind: { label: "Which kind of record (e.g. inventory:part)", type: "text" },
      fields: { label: "The fields, comma-separated, by their labels on the form", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:create-instance",
    min_role: "grantable",
    label: "Create a list (instance)",
    description:
      "Create a separate skinned list from a module the workspace already has — 3D Printers and CNC both from Machines, each with its own nav entry, fields and label codes. Runs on the workspace, not a record. The result names the new list's kind id (e.g. cnc:item) — use that with list_records and create_record. Check what exists with get_workspace_setup (instances) first.",
    icon: "layout-grid",
    scope: "workspace",
    invoke_handler: "platform.create-instance",
    user_invokable: true,
    // a whole list, its nav entry and its label-code group; undoing it is not one step
    undoable: false,
    examples: ["make a separate list for CNC machines", "I want 3D printers and laser cutters kept apart"],
    args_schema: {
      module_name: { label: "The module to make a list from (e.g. machines)", type: "text" },
      display_name: { label: "What to call the list (e.g. CNC Machines)", type: "text" },
      instance_name: { label: "Short name (lowercase; derived from the display name if omitted)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:enable-module",
    min_role: "grantable",
    label: "Turn on a feature",
    description:
      "Turn on one of Cobblr's features for this workspace (Purchases, Maintenance, Shipments, …) so its screens and records appear. Name it the way it is written in the app. Turning one on is safe and repeatable: a feature already on says so rather than doing anything. Runs on the workspace, not a record. Use get_workspace_setup to see what is already on.",
    icon: "toggle-right",
    scope: "workspace",
    invoke_handler: "platform.enable-module",
    user_invokable: true,
    // nothing is written to anyone's records: turning it back off is the undo,
    // and a feature that was already on is left exactly as it was.
    undoable: true,
    examples: ["turn on purchases", "I want to track maintenance", "add shipments to this workspace"],
    args_schema: {
      module: { label: "The feature, by its name in the app (e.g. Purchases)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:disable-module",
    min_role: "grantable",
    label: "Turn off a feature",
    description:
      "Turn one of Cobblr's features off for this workspace: its screens leave the navigation. Records already stored are kept and come back if it is turned on again, but the fields and automations that came WITH the feature are cleared out. Refuses when another feature in use depends on it, and says which. Runs on the workspace, not a record.",
    icon: "toggle-left",
    scope: "workspace",
    invoke_handler: "platform.disable-module",
    user_invokable: true,
    // the records survive, but the feature's own field defs and automations are
    // removed with it, and turning it back on does not remember how they were set
    undoable: false,
    examples: ["turn off shipments", "I don't use maintenance, take it out"],
    args_schema: {
      module: { label: "The feature, by its name in the app (e.g. Shipments)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:rename-thing",
    min_role: "grantable",
    label: "Rename what a list is called",
    description:
      "Change the words this workspace uses for a kind of record or a list: Parts becomes Spools, Machines becomes Printers. It renames the LABEL only, everywhere it is shown (navigation, headings, buttons); nothing recorded moves and no id changes. Give both the singular and the plural when they are not the plain +s. Runs on the workspace, not a record. Use get_workspace_setup to see what the lists are called now.",
    icon: "text-cursor-input",
    scope: "workspace",
    invoke_handler: "platform.rename-thing",
    user_invokable: true,
    // a label, and nothing but a label: renaming it back is the whole undo
    undoable: true,
    examples: ["call my parts spools", "rename Machines to Printers", "we call those bins totes"],
    args_schema: {
      target: { label: "What to rename, by what it is called now (e.g. Parts)", type: "text" },
      name: { label: "What to call one of them (e.g. Spool)", type: "text" },
      plural: { label: "What to call several (e.g. Spools). Defaults to the name plus s", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:promote-category",
    min_role: "grantable",
    label: "Give a category its own list",
    description:
      "Take one category out of a list and give it a list of its own: the Spices in Pantry become their own Spices list, with its own nav entry, fields and label codes. Records keep their ids, their history and their printed labels; only which list they are in changes. Reversible with the fold-back action. Runs on the workspace, not a record.",
    icon: "split",
    scope: "workspace",
    invoke_handler: "platform.promote-category",
    user_invokable: true,
    // the fold-back action is its exact inverse, by design: promote, demote,
    // promote lands you where you started
    undoable: true,
    examples: ["give spices their own list", "pull CNC out of machines into its own thing"],
    args_schema: {
      from: { label: "The list the category is in now (e.g. pantry)", type: "text" },
      category: { label: "The category to pull out (e.g. Spices)", type: "text" },
      display_name: { label: "What to call the new list (defaults to the category)", type: "text" },
      instance_name: { label: "Short name for it (lowercase; derived from the display name if omitted)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:demote-category",
    min_role: "grantable",
    label: "Fold a list back into another",
    description:
      "Fold a list back into another list of the same kind, as a category there: the Spices list goes back into Pantry, stamped with the category you name. Everything in it moves; records keep their ids and their labels. The exact reverse of giving a category its own list. Runs on the workspace, not a record.",
    icon: "merge",
    scope: "workspace",
    invoke_handler: "platform.demote-category",
    user_invokable: true,
    // promoting it again puts it back, which is the pair this action belongs to
    undoable: true,
    examples: ["fold spices back into the pantry", "put CNC back under machines as a category"],
    args_schema: {
      list: { label: "The list to fold away (e.g. spices)", type: "text" },
      into: { label: "The list it goes back into (e.g. pantry)", type: "text" },
      category: { label: "The category to stamp them with (defaults to the list's name)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:rename-workspace",
    label: "Rename this workspace",
    description:
      "Change what this workspace is called. The name only: its web address stays as it is, so links, bookmarks and printed labels keep working. Owner only. Runs on the workspace, not a record.",
    icon: "pencil-line",
    scope: "workspace",
    invoke_handler: "platform.rename-workspace",
    user_invokable: true,
    // Owner-only on BOTH rails. The REST twin (PATCH /orgs/:slug) is hard
    // `role === "owner"`; without this floor the action rail let any admin
    // rename through the generic invoke (audit M-ACTION-PARITY).
    min_role: "owner",
    // a name: setting it back is the whole undo
    undoable: true,
    examples: ["call this workspace The Garage", "rename my workspace to Home"],
    args_schema: {
      name: { label: "What to call it", type: "text" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:set-simple-mode",
    min_role: "grantable",
    label: "Turn simple mode on or off",
    description:
      "Simple mode declutters this workspace to a calm everyday view: the advanced configuration surfaces are put away, and the things you use daily stay. Nothing is deleted or turned off, and switching it back shows everything again. Owner or admin. Runs on the workspace, not a record.",
    icon: "eye-off",
    scope: "workspace",
    invoke_handler: "platform.set-simple-mode",
    user_invokable: true,
    // a view setting, and the opposite call is the undo
    undoable: true,
    examples: ["this is too cluttered, simplify it", "turn simple mode off, I want the advanced screens"],
    args_schema: {
      on: { label: "True for simple, false for everything", type: "boolean" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:set-field-preset",
    min_role: "grantable",
    label: "Switch a set of fields on or off",
    description:
      "Switch on a named SET of fields that belong together, in one go, across everything they apply to: 'provenance' puts where each thing came from, when, and what it cost onto every physical thing the workspace tracks, now and in future. Switching it off takes the fields away and KEEPS anything already recorded in them, which comes back if it goes on again. Runs on the workspace, not a record. Ask for the list with get_workspace_setup.",
    icon: "layers",
    scope: "workspace",
    invoke_handler: "platform.set-field-preset",
    user_invokable: true,
    // symmetric, and nothing recorded is lost either way
    undoable: true,
    examples: ["track where my things came from", "turn on provenance", "stop tracking what things cost"],
    args_schema: {
      preset: { label: "Which set (e.g. provenance)", type: "text" },
      on: { label: "True to switch it on, false to take it away", type: "boolean" },
    },
    version: "0.1.0",
  },
  {
    id: "platform:set-wire-enabled",
    min_role: "grantable",
    label: "Turn an automation on or off",
    description:
      "Switch one automation (wire) on or off by its id — find the id with get_workspace_setup (automations). Toggling only stops or restarts behavior the user already set up; automations cannot be created or edited this way. Runs on the workspace, not a record.",
    icon: "toggle-left",
    scope: "workspace",
    invoke_handler: "platform.set-wire-enabled",
    user_invokable: true,
    // a toggle: setting it back is the whole undo
    undoable: true,
    examples: ["stop the low stock wire from firing", "turn that automation back on"],
    args_schema: {
      wire_id: { label: "The automation's id", type: "text" },
      enabled: { label: "On (true) or off (false)", type: "boolean" },
    },
    version: "0.1.0",
  },
];

/**
 * The minimum role this action requires, or null if it inherits the invoke
 * route's default gate (`requireCapability`). The invoke route reads this AFTER
 * `requireCapability` and enforces it with `roleSatisfies`, so a kernel action
 * can be pinned to the same floor as its REST twin (audit M-ACTION-PARITY).
 *
 * Sourced from the in-memory declarations — no DB round-trip. Only the kernel's
 * own "platform:*" actions can carry a floor today (a module manifest has no
 * `min_role` field), so a non-platform id is always null.
 */
export function platformActionMinRole(actionId: string): OrgRoleName | null {
  const floor = PLATFORM_ACTIONS.find((a) => a.id === actionId)?.min_role;
  // "grantable" is an explicit "no hard floor" — the invoke route's
  // requireCapability (owner/admin, or a member with a grant) governs. Only a
  // real role rung is enforced as a floor.
  return floor && floor !== "grantable" ? floor : null;
}

/** Thrown by {@link assertActingRoleClearsActionFloor} when the acting user's
 *  role does not clear an action's min_role floor. Carries the pieces a caller
 *  needs to shape its own refusal (an HTTP 403 body, a neutral Discord card). */
export class ActionRoleFloorError extends Error {
  constructor(
    readonly actionId: string,
    readonly requiredRole: OrgRoleName,
    readonly actingRole: string | null,
  ) {
    super(`The ${actionId} action requires the ${requiredRole} role.`);
    this.name = "ActionRoleFloorError";
  }
}

/**
 * Enforce a platform action's min_role floor for an identity-carrying caller
 * that reaches {@link ActionsAPI.invoke} DIRECTLY — the Discord button press and
 * the bundle-upgrade migration — instead of through the HTTP POST /actions/invoke
 * route (which enforces the same floor inline against `req.tenant.role`). Throws
 * {@link ActionRoleFloorError} when the role is short; a no-op for any action
 * without a floor, which is every module action and every platform action that
 * inherits the default `requireCapability` gate.
 *
 * This is the ONE seam for that check off the HTTP route. It exists because the
 * floor was landed in the route ALONE (audit M-ACTION-PARITY), so the two other
 * callers of invoke() that act for a specific user could reach a floored action
 * without it — benign today (no owner-only platform:* action is card- or
 * migration-reachable), but the floor must hold at every door, not only the REST
 * one.
 *
 * NOT for automation. Wires and recurrence run with the wire AUTHOR's authority,
 * not a triggering user's, and MUST NOT be role-gated at firing (see the NOTE in
 * actions.ts `invoke`). They never call this; only a path acting on behalf of a
 * signed-in USER does. `roleSatisfies` is rank-based, so a higher role always
 * clears a lower floor.
 */
export function assertActingRoleClearsActionFloor(
  actionId: string,
  actingRole: string | null | undefined,
): void {
  const minRole = platformActionMinRole(actionId);
  if (minRole && !roleSatisfies(actingRole, [minRole])) {
    throw new ActionRoleFloorError(actionId, minRole, actingRole ?? null);
  }
}
