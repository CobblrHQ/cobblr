import { productName } from "./product-name.js";
import type { ActionGroupId } from "@cobblr/platform-contract/action-groups";
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

import { PLATFORM_OWNER } from "@cobblr/platform-contract";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

/** The reserved owner. lint-manifests refuses a module named this. One
 *  constant, in the contract, so the registry, the assistant's loader and
 *  the lint cannot disagree on the spelling. */
export const PLATFORM_ACTION_OWNER = PLATFORM_OWNER;

/** Shape-compatible with the rows registry-sync builds from module manifests. */
export interface PlatformActionDecl {
  group: ActionGroupId;
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
  /** What running it changes: the workspace's data (its records), or its
   *  setup (its settings, fields, lists, features, automations, people and
   *  shares). A token that may only change records (`change`, token-access.ts)
   *  runs the first and never the second (#7138). Required, so a new action
   *  is classified when it is written. */
  changes: "data" | "setup";
  /** Who runs it without a grant, when a route does the same thing for them
   *  (#5170, action-gates.ts). min_role stays the floor below which nobody may. */
  run_by?: Exclude<OrgRoleName, "guest"> | "requester";
  // "list" is a JSON array of values, the way core-locations:reorder takes its
  // ids. The kernel's own actions had never needed one, so this local type had
  // never grown it.
  // "json" is an object value (a service's input). `picker` asks the form
  // for a chooser instead of a text box; `schema_from` names the argument
  // whose choice decides this one's fields (a capability's input schema).
  args_schema: Record<
    string,
    { label: string; type: "text" | "boolean" | "number" | "list" | "json"; required?: boolean; oneOf?: string; picker?: "service-capability"; schema_from?: string }
  >;
  version: string;
  /** Never offered to the assistant, on the rail or in list_actions, and
   *  never a button: run from a card a person presses (a notification's
   *  Approve/Deny) and nothing else. A decision about a person is not the
   *  assistant's to make. */
  wire_only?: boolean;
  /** A wire runs it once per event on no record (target "none"): it acts
   *  on the workspace, not on a record. The wire composer offers these for
   *  "No record", and nothing else lists them. */
  recordless?: boolean;
}

export const PLATFORM_ACTIONS: PlatformActionDecl[] = [
  {
    // UI-SCREEN: /configuration/record-actions
    id: "platform:edit-record-actions", changes: "setup", group: "organise", label: "Arrange record actions", description: "Rename or reorder action groups, move actions, hide them or choose primaries on a kind of record. Changes can be undone.", icon: "sliders", scope: "workspace", min_role: "admin", invoke_handler: "platform.edit-record-actions", user_invokable: true, undoable: true,
    examples: ["put Log service and Set a schedule under Vehicle care on printers", "hide Print label on parts"],
    args_schema: { kind: { label: "Kind of record", type: "text", required: true }, group: { label: "Group", type: "text" }, label: { label: "Group name", type: "text" }, actions: { label: "Actions to move", type: "list" }, order: { label: "Group order", type: "number" }, hidden: { label: "Hidden", type: "boolean" }, primary: { label: "Primary", type: "boolean" }, layout: { label: "Complete layout", type: "json" }, expected_revision: { label: "Version being edited", type: "number" } }, version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/record-actions
    id: "platform:arrange-record-panels", changes: "setup", group: "organise", label: "Arrange record panels", description: "Hide the panels a kind of record does not need, or put them in another order: Loaded filament above Service schedule on 3D printers, say. Hidden panels can be shown again, and changes can be undone.", icon: "sliders", scope: "workspace", min_role: "admin", invoke_handler: "platform.arrange-record-panels", user_invokable: true, undoable: true,
    examples: ["hide Bench instrument on 3D printers", "put Loaded filament first on printers"],
    args_schema: { kind: { label: "Kind of record", type: "text", required: true }, panels: { label: "Panels to hide or show", type: "list" }, hidden: { label: "Hidden", type: "boolean" }, order: { label: "Panels in order, top first", type: "list" }, layout: { label: "Complete arrangement", type: "json" }, expected_revision: { label: "Version being edited", type: "number" } }, version: "0.1.0",
  },
  {
    // UI-SCREEN: /apps (an app's edit form)
    group: "organise",
    id: "platform:update-fields", changes: "data", run_by: "member", label: "Change a record's fields", icon: "pencil",
    description: "Correct fields on one record: a part's name or where it is kept, a project's status. Only fields you can see change, and only on kinds of record that can be edited this way. The record's history shows the change.",
    examples: ["rename part M3 bolt to M3 x 8 bolt", "move the soldering iron to the top shelf"],
    scope: "workspace", min_role: "member", invoke_handler: "platform.update-fields", user_invokable: true, undoable: false,
    args_schema: {
      kind: { label: "Kind of record", type: "text", required: true },
      id: { label: "Record id", type: "text", required: true },
      fields: { label: "Fields to change, by name", type: "json", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/people
    group: "more",
    id: "platform:add-person", changes: "setup", run_by: "member", label: "Add a person", icon: "user-plus",
    description: "Put someone on the workspace's People list by name, so records can belong to them and automations can message them: a partner, a neighbour, a shop. Optional email, and phone in international form (+1 555 010 0123) for a text. Adding someone does not invite them; they are not a member.",
    examples: ["add Alex to the people list", "add Sam, sam@example.com, +1 555 010 0123"],
    scope: "workspace", min_role: "member", invoke_handler: "platform.add-person", user_invokable: true, undoable: false,
    args_schema: {
      name: { label: "Name", type: "text", required: true },
      email: { label: "Email", type: "text" },
      phone: { label: "Phone, with the country code (+1 555 010 0123)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/people
    group: "more",
    id: "platform:edit-person", changes: "setup", run_by: "member", label: "Change a person's details", icon: "pencil",
    description: "Change the name, email or phone of someone on the People list, found by name or id. A blank email or phone clears it. A member's name is their account's and is not changed here. The phone is in international form (+1 555 010 0123).",
    examples: ["Alex's phone is +1 555 010 0123", "change Sam's email to sam@example.com"],
    scope: "workspace", min_role: "member", invoke_handler: "platform.edit-person", user_invokable: true, undoable: false,
    args_schema: {
      person: { label: "Who, by name or id", type: "text", required: true },
      name: { label: "New name", type: "text" },
      email: { label: "Email (blank clears it)", type: "text" },
      phone: { label: "Phone, with the country code (blank clears it)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/recently-deleted
    group: "lifecycle",
    id: "platform:restore-deleted-record", changes: "data", run_by: "member", label: "Restore a deleted record", icon: "history",
    description: "Bring a record from Recently deleted back with its original id and contents. Deleted records are kept for 30 days. Args: kind and entity_id.",
    scope: "workspace", min_role: "member", invoke_handler: "platform.restore-deleted-record", user_invokable: true, undoable: false,
    args_schema: { kind: { label: "Record kind", type: "text", required: true }, entity_id: { label: "Record id", type: "text", required: true } },
    version: "0.1.0",
  },
  {
    // UI-REACH: Restore this version in every record's History panel
    group: "lifecycle",
    id: "platform:restore-record-version", changes: "data",
    label: "Restore a record version",
    description: "Restore the values from before a saved edit, replacing later edits and recording a restorable change. Read the record's activity first; entry_id selects the edit and expected_latest_id is its newest history entry. Runs on the workspace. Fields you cannot read stay unchanged.",
    examples: ["put this record back to before that edit", "restore the previous version of this item"],
    icon: "history",
    scope: "workspace",
    min_role: "admin",
    invoke_handler: "platform.restore-record-version",
    user_invokable: true,
    undoable: true,
    args_schema: {
      kind: { label: "Record kind", type: "text", required: true },
      entity_id: { label: "Record id", type: "text", required: true },
      entry_id: { label: "The saved edit to restore", type: "number", required: true },
      expected_latest_id: { label: "Newest history entry read for this record", type: "number", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /inventory, /assets, /machines, /views
    group: "organise",
    id: "platform:set-field-on-records", changes: "data",
    label: "Set field on selected records",
    description: "Set or clear one writable built-in or custom field on up to 500 records. Pass records as [{kind,id}], the exact field name and value (null clears it). Only fields shared by every selected kind are accepted. Failed rows are listed and skipped. One Undo restores the successful rows. Runs on the workspace.",
    examples: ["set Brand to Hakko on these parts", "clear the warranty date on the selected items"],
    icon: "pencil",
    scope: "workspace",
    min_role: "admin",
    invoke_handler: "platform.set-field-on-records",
    user_invokable: true,
    undoable: true,
    args_schema: {
      records: { label: "The selected records as kind and id pairs", type: "list", required: true },
      field: { label: "The field's storage name", type: "text", required: true },
      value: { label: "The new value, or null to clear", type: "json" },
    },
    version: "0.1.0",
  },
  {
    // NO-PHRASING: the undo of a batch field edit, returned on its card
    // UI-REACH: Undo in the Set field toast
    group: "lifecycle",
    id: "platform:restore-batch-field", changes: "data",
    label: "Undo setting a field",
    description: "Restore the previous field values from a bulk field edit. A row changed since the batch keeps its newer value and is listed as skipped.",
    icon: "undo-2",
    scope: "workspace",
    min_role: "admin",
    invoke_handler: "platform.restore-batch-field",
    user_invokable: true,
    wire_only: true,
    undoable: false,
    args_schema: {
      field: { label: "The field's storage name", type: "text", required: true },
      changes: { label: "The batch's successful changes", type: "list", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /fields
    group: "organise",
    id: "platform:add-field", changes: "setup",
    min_role: "grantable",
    label: "Add a field",
    description:
      "Add ONE custom field to one kind of record (e.g. inventory:part), or to a whole class of them with a trait scope (e.g. @physical puts it on everything physical: 'track a colour on every physical thing' is this action with entity_kind @physical). Types: text (choices makes it a dropdown), number (with a unit), date, boolean, relation (needs ref_kind: the kind it points at). Runs on the workspace, not a record. Check the kind's existing fields with list_record_kinds first. Fields cannot be edited or deleted this way, only added. (A named SET of fields the workspace already defines, like provenance, is platform:set-field-preset; a new field is never a preset.)",
    icon: "list-plus",
    scope: "workspace",
    invoke_handler: "platform.add-field",
    user_invokable: true,
    // a field cannot be removed by this rail (its own description says added-only), so a wrong one stays
    undoable: false,
    examples: ["add a Purchase Date field to parts", "track a colour on every physical thing"],
    args_schema: {
      without_meaning: { label: "Add it as a field of its own even though the kind already has one meaning the same (it is made without that meaning)", type: "boolean" },
      entity_kind: { label: "Which kind of record (or a trait scope like @physical)", type: "text", required: true },
      display_label: { label: "The field's label (e.g. Purchase Date)", type: "text", required: true },
      name: { label: "Storage name (lowercase; derived from the label if omitted)", type: "text" },
      type: { label: "text, number, date, boolean, relation (or: dropdown, checkbox)", type: "text" },
      choices: { label: "For a dropdown: the choices, comma-separated", type: "text" },
      unit: { label: "For a number: its unit (mm, g, in)", type: "text" },
      ref_kind: { label: "For a relation: the kind it points at", type: "text" },
      required: { label: "Must be filled in", type: "boolean" },
    },
    version: "0.1.0",
  },
  {
    group: "more",
    id: "platform:track-sellers", changes: "setup",
    label: "Track sellers as their own field",
    icon: "store",
    version: "0.1.0",
    description:
      "Give a kind of record a Seller field of its own and move every seller noted beside where things came from (eBay · detroitaxle) into it, so a seller can be filtered and grouped across places. Undoable. Args: { entity_kind }.",
    examples: ["track sellers as their own field on my parts", "make the seller its own field"],
    // UI-SCREEN: /fields
    scope: "workspace",
    min_role: "admin",
    invoke_handler: "platform.track-sellers",
    user_invokable: true,
    undoable: true,
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
    },
  },
  {
    // NO-PHRASING: the undo step of track-sellers, handed back on its card
    // UI-REACH: an undo step; the toast after Track sellers runs it
    group: "more",
    id: "platform:untrack-sellers", changes: "setup",
    label: "Put sellers back as notes",
    icon: "undo-2",
    version: "0.1.0",
    description: "Undo of track-sellers: every seller back as a note beside where it came from, and the Seller field removed.",
    scope: "workspace",
    min_role: "admin",
    invoke_handler: "platform.untrack-sellers",
    user_invokable: true,
    wire_only: true,
    undoable: false,
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
      field_id: { label: "The Seller field's id", type: "text", required: true },
    },
  },
  {
    group: "organise",
    id: "platform:decline-seller-field", changes: "setup",
    label: "Keep sellers as notes",
    icon: "x",
    version: "0.1.0",
    description: "Answer no to tracking sellers as their own field on a kind of record: it is not offered again for that kind (the Fields page still has it). Args: { entity_kind }.",
    examples: ["no, keep sellers as notes"],
    // UI-SCREEN: /fields
    scope: "workspace",
    min_role: "admin",
    invoke_handler: "platform.decline-seller-field",
    user_invokable: true,
    undoable: false,
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
    },
  },
  {
    group: "more",
    id: "platform:settle-same-meaning", changes: "setup",
    label: "Settle two fields that mean one thing",
    icon: "merge",
    version: "0.1.0",
    description:
      "When one kind of record has two fields with the same meaning (say Store and Acquired from), keep one: the other's values move into it where it is empty, and the other is hidden and loses the meaning. Only a field the workspace made can be let go. Undoable. Args: { entity_kind, keep, drop } (fields by name or label).",
    examples: ["keep Acquired from and get rid of Store on my parts", "merge the two where-it-came-from fields"],
    // UI-SCREEN: /fields
    scope: "workspace",
    min_role: "admin",
    invoke_handler: "platform.settle-same-meaning",
    user_invokable: true,
    undoable: true,
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
      keep: { label: "The field to keep", type: "text", required: true },
      drop: { label: "The field to let go", type: "text", required: true },
    },
  },
  {
    // NO-PHRASING: the undo step of settle-same-meaning, handed back on its card
    // UI-REACH: an undo step; the toast after Keep runs it
    group: "more",
    id: "platform:unsettle-same-meaning", changes: "setup",
    label: "Put two fields back as they were",
    icon: "undo-2",
    version: "0.1.0",
    undoable: false,
    description: "Undo of settle-same-meaning: values moved back, the meaning and visibility restored.",
    scope: "workspace",
    min_role: "admin",
    invoke_handler: "platform.unsettle-same-meaning",
    user_invokable: true,
    wire_only: true,
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
      keep: { label: "The field that was kept", type: "text", required: true },
      drop: { label: "The field that was let go", type: "text", required: true },
      drop_id: { label: "The let-go field's id", type: "text", required: true },
    },
  },
  {
    // UI-SCREEN: /fields
    group: "organise",
    id: "platform:edit-field", changes: "setup",
    min_role: "grantable",
    // The label is all an unfiltered list_actions shows, and "Change a field"
    // read as rename-only: "make Purchase Date required" was answered "that
    // is not supported" in 10 nightlies of 22 (#6562).
    label: "Change a field: rename, require, hide or edit its choices",
    description:
      "Change a field that already exists on a kind of record: rename its label, hide it from forms and lists (or show it again), make it required, or change a dropdown's choices: add_choices and remove_choices take one or more by name ('remove Tea from the category choices' is remove_choices Tea; no need to know the rest of the list), choices replaces the whole list. Works on the workspace's own fields AND on the ones a module ships (a part's manufacturer, a machine's serial number), of which the label, whether it shows, and its choices are yours to set. Name the field the way it appears on the form. Runs on the workspace, not a record. What it CANNOT do is change a field's type or its storage name, because values already recorded are stored under both.",
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
      "remove Tea from the category choices, it is no longer a valid option",
      "stop remembering new entries in the yarn weight dropdown",
    ],
    args_schema: {
      entity_kind: { label: "Which kind of record the field is on (e.g. inventory:part)", type: "text" },
      field: { label: "The field, by the label shown on the form (e.g. Purchase Date)", type: "text", required: true },
      display_label: { label: "New label for it", type: "text" },
      required: { label: "Whether it must be filled in", type: "boolean" },
      add_choices: { label: "For a dropdown: choices to add, by name, comma-separated (the rest stay)", type: "text" },
      remove_choices: { label: "For a dropdown: choices to take off, by name, comma-separated (the rest stay)", type: "text" },
      choices: { label: "For a dropdown: the full list of choices, comma-separated (replaces what is there)", type: "text" },
      learns: { label: "For a dropdown: whether a value someone types on a record is remembered as a choice for the next one", type: "boolean" },
      unit: { label: "For a number: its unit (mm, g, in)", type: "text" },
      hidden: { label: "True to take it off forms and lists, false to show it again", type: "boolean" },
    },
    version: "0.3.0",
  },
  {
    // UI-SCREEN: /assets (any record's choice field: typing a new value)
    group: "more",
    id: "platform:learn-choice", changes: "data", run_by: "member",
    min_role: "member",
    label: "Remember a new choice",
    description:
      "Remember what a person typed into a field that learns (a dropdown that grows as it is used) as one of its choices, so the next record offers it. Pressed by the field itself, never by the assistant: a value someone types is their choice, a value something read is not.",
    icon: "list-plus",
    scope: "workspace",
    invoke_handler: "platform.learn-choice",
    user_invokable: true,
    // Taking it back off is forget-choice, and nothing recorded moves.
    undoable: true,
    wire_only: true,
    args_schema: {
      entity_kind: { label: "The kind of record the field is on", type: "text", required: true },
      field: { label: "The field's storage name", type: "text", required: true },
      value: { label: "What was typed", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /assets (the Undo on "remembered as a choice")
    group: "more",
    id: "platform:forget-choice", changes: "data", run_by: "member",
    min_role: "member",
    label: "Forget a choice",
    description: "Take a value back off a field's choices: the undo of remembering one. Values already recorded stay as they are.",
    icon: "list-minus",
    scope: "workspace",
    invoke_handler: "platform.forget-choice",
    user_invokable: true,
    undoable: false,
    wire_only: true,
    args_schema: {
      entity_kind: { label: "The kind of record the field is on", type: "text", required: true },
      field: { label: "The field's storage name", type: "text", required: true },
      value: { label: "The choice to take off", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /fields
    group: "organise",
    id: "platform:remove-field", changes: "setup",
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
      field: { label: "The field, by the label shown on the form (e.g. Shelf Life)", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /fields
    group: "organise",
    id: "platform:group-fields", changes: "setup",
    min_role: "grantable",
    label: "Group fields under a heading",
    description:
      "Put custom fields under a named heading on a kind's FORM (the section a record's fields sit under when you open it), creating the heading if it does not exist yet. Name the fields the way they appear on the form; the order you name them is the order they get. Pass rename_to instead of fields to RENAME a heading that is already there ('rename the Buying heading to Purchasing': section Buying, rename_to Purchasing). Runs on the workspace, not a record. Fields that apply to a whole class of records cannot be grouped this way, since their layout is not one kind's to set. (The headings in the SIDEBAR, over the workspace's lists, are core-presentation:group-nav, not this.)",
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
      entity_kind: { label: "Which kind of record (e.g. inventory:part); may be left out when renaming a heading only one kind has", type: "text" },
      section: { label: "The heading to put them under (e.g. Buying)", type: "text", required: true },
      fields: { label: "The fields, comma-separated, by their labels on the form", type: "text", oneOf: "what-to-change" },
      rename_to: { label: "To RENAME the heading instead: what to call it now", type: "text", oneOf: "what-to-change" },
    },
    version: "0.2.0",
  },
  {
    // UI-SCREEN: /fields
    group: "organise",
    id: "platform:ungroup-fields", changes: "setup",
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
      entity_kind: { label: "Which kind of record (e.g. inventory:part)", type: "text", required: true },
      fields: { label: "The fields, comma-separated, by their labels on the form", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    group: "organise",
    id: "platform:create-instance", changes: "setup",
    min_role: "grantable",
    label: "Create a list (instance)",
    description:
      "Create a separate skinned list from a module the workspace already has — 3D Printers and CNC both from Machines, each with its own nav entry, fields and label codes. Runs on the workspace, not a record. The result names the new list's kind id (e.g. cnc:item) — use that with list_records and create_record. Check what exists with get_workspace_setup (instances) first.",
    icon: "layout-grid",
    scope: "workspace",
    invoke_handler: "platform.create-instance",
    user_invokable: true,
    // Its undo is platform:remove-list, which takes a list away again while
    // nothing is filed in it: the list, its menu entry and its label codes.
    undoable: true,
    examples: ["make a separate list for CNC machines", "I want 3D printers and laser cutters kept apart", "create Mugs and file these in it"],
    args_schema: {
      module_name: { label: "The module to make a list from (e.g. machines)", type: "text", required: true },
      display_name: { label: "What to call the list (e.g. CNC Machines)", type: "text", required: true },
      instance_name: { label: "Short name (lowercase; derived from the display name if omitted)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    group: "more",
    id: "platform:remove-list", changes: "setup",
    min_role: "grantable",
    label: "Remove an empty list",
    description:
      "Take away a list made from a module (an instance such as Mugs or CNC Machines) while nothing is filed in it: the list, its menu entry and its label codes go. A list that still holds records is refused, naming how many; move or delete them first. Runs on the workspace, not a record.",
    icon: "layout-grid",
    scope: "workspace",
    invoke_handler: "platform.remove-list",
    user_invokable: true,
    // Its undo makes the same list again (platform:create-instance), and it
    // only ever removes a list with nothing in it, so nothing else is lost.
    undoable: true,
    examples: ["remove the Mugs list", "I don't need the CNC list any more, it's empty"],
    args_schema: {
      list: { label: "The list, by its name in the app (e.g. Mugs)", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/modules
    group: "more",
    id: "platform:enable-module", changes: "setup",
    min_role: "grantable",
    label: "Turn on a feature",
    description:
      `Turn on one of ${productName()}'s features for this workspace (Purchases, Maintenance, Shipments, …) so its screens and records appear. Name it the way it is written in the app. Turning one on is safe and repeatable: a feature already on says so rather than doing anything. Runs on the workspace, not a record. Use get_workspace_setup to see what is already on.`,
    icon: "toggle-right",
    scope: "workspace",
    invoke_handler: "platform.enable-module",
    user_invokable: true,
    // nothing is written to anyone's records: turning it back off is the undo,
    // and a feature that was already on is left exactly as it was.
    undoable: true,
    examples: ["turn on purchases", "I want to track maintenance", "add shipments to this workspace"],
    args_schema: {
      module: { label: "The feature, by its name in the app (e.g. Purchases)", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/modules
    group: "more",
    id: "platform:set-module-part", changes: "setup",
    min_role: "grantable",
    label: "Turn part of a feature on or off",
    description:
      `Turn one part of a feature on or off for this workspace (Robot arms in Digital Fabrication, …), so its screens, actions and tools appear or disappear. Off hides it and keeps everything it recorded; on again shows all of it. Name the feature and the part the way the app writes them; on is true or false, or omit it to follow the part's default again. Runs on the workspace, not a record. Use get_workspace_setup to see each feature's parts.`,
    icon: "toggle-right",
    scope: "workspace",
    invoke_handler: "platform.set-module-part",
    user_invokable: true,
    // Its undo puts the part's previous choice back, or forgets the choice
    // when there was none; nothing a part recorded is ever touched.
    undoable: true,
    examples: ["turn on robot arms", "hide the robot arm screens, we don't have arms", "follow the default for robot arms again"],
    args_schema: {
      module: { label: "The feature, by its name in the app (e.g. Digital Fabrication)", type: "text", required: true },
      part: { label: "The part, by its name in the app (e.g. Robot arms)", type: "text", required: true },
      on: { label: "On (true) or off (false); omit to follow the default", type: "boolean" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /settings/connections (Who answers for you)
    group: "more",
    id: "platform:set-my-default-ai", changes: "setup", run_by: "member",
    min_role: "member",
    label: "Choose your own AI for a kind of work",
    description:
      "Set which of the person's own AI connections answers a kind of work for them, in every workspace they use unless that workspace chose its own: job is photos (reading scans), chat, text (organising, summaries) or search. steps is First then the fallbacks, each { connection, model }: the connection by its name, the model by its name (Flash Lite; a family name such as Haiku follows its newest version, Haiku 4.5 keeps that version). No steps clears the job. Changes only the person's own choice, never anyone else's.",
    icon: "sparkles",
    scope: "workspace",
    invoke_handler: "platform.set-my-default-ai",
    user_invokable: true,
    // Its undo puts the job's previous steps back, or clears it when there
    // were none; it changes only the caller's own choice.
    undoable: true,
    examples: ["use Flash Lite for scans", "answer my chat with Claude Sonnet, then Gemini", "stop using my own AI for search"],
    args_schema: {
      job: { label: "The kind of work: photos, chat, text or search", type: "text", required: true },
      steps: { label: "First, then fallbacks: each a connection and a model, by name", type: "list" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /vault
    // The assistant's one door into the Vault (#5242): IN only. It files a
    // document the person gave it into a folder they own and removes the
    // plain copy; no tool reads a vault document out or lists a folder, so a
    // personal document never reaches a model through the assistant.
    group: "more",
    id: "platform:file-into-vault", changes: "data", run_by: "member",
    min_role: "member",
    label: "File a document in your Vault",
    description:
      "Put a document the person gave you (file_id, an uploaded file) into their Vault, encrypted, readable only by the people its folder names, and remove the plain copy from Files. folder names one of the person's own Vault folders by name or id; without it, their \"Personal documents\" folder, made the first time. record_kind and record_id say which record it belongs to (a car's registration renewal). You can never read a Vault document or list a folder.",
    icon: "lock",
    scope: "workspace",
    invoke_handler: "platform.file-into-vault",
    user_invokable: true,
    // Not undoable: undoing would put a personal document back in Files as
    // a plain copy, the thing filing it removed. Remove it in the Vault.
    undoable: false,
    examples: ["put this registration in my Vault", "file this passport scan in my Vault folder Family"],
    args_schema: {
      file_id: { label: "The document: the id of the file the person gave you", type: "text", required: true },
      folder: { label: "Which of your Vault folders, by name or id (default: Personal documents)", type: "text" },
      record_kind: { label: "The record it belongs to: its kind", type: "text" },
      record_id: { label: "The record it belongs to: its id", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: / (the dashboard's offer to move records into the collection they belong in)
    group: "more",
    id: "platform:move-records", changes: "data",
    min_role: "grantable",
    label: "Move records into another list",
      // The boundary sentence is load-bearing, and its absence was measurable. This
      // action is NEWER than core-placement:place, and adding it to the rail changed the
      // answer to sentences it has nothing to do with: the corpus case "the rice lives in
      // the pantry now" wants core-placement:place and began returning move-records the day
      // this shipped, taking the kitchen bucket to 13/14 against a 100% floor and stopping
      // the nightly channel for two days (2026-09-09 to 09-11).
      //
      // The old example made it worse rather than better: "the tea in Pantry" put a pantry
      // into the one description a model reads when deciding what a sentence about a pantry
      // means. The example now names two things that are plainly lists, and the exclusion
      // says out loud which action owns the other reading.
    description:
      "Move records that already exist from one list into another (the chamomile in Inventory into the Tea list). The records keep their ids, their photos, their history and their printed labels; only which list they are in changes. This is the ONLY way to move something between lists: creating a record in the new list leaves the original where it was and makes a second copy, and deleting it destroys what was there. NOT for where a thing physically IS: a destination that is a place rather than a list (a room, a shelf, a bin, a pantry) is core-placement:place, and so is any sentence about a thing living, sitting or being kept somewhere. Runs on the workspace, not a record. Read the records first and pass their real ids.",
    icon: "folder-input",
    scope: "workspace",
    invoke_handler: "platform.move-records",
    user_invokable: true,
    // NOT undoable, in the specific sense this flag carries: an AI may not run
    // it without a person confirming. It is a bulk change to where someone's
    // things live, and the card naming what moves, before it moves, is the
    // point. The way BACK is a different thing and it has one: the same move
    // the other way, registered beside the handler (registerUndo), which is
    // what puts Undo on the card after it runs.
    //
    // It still runs from the app, from a wire, and from any chat that can show
    // a confirm card. Only a relay with no way to ask refuses, and says which
    // action it was.
    undoable: false,
    examples: [
      "move all the tea into the Tea list",
      "file these three in Spices",
      "put the chamomile in Tea",
    ],
    args_schema: {
      ids: { label: "The records to move, by id (read them first)", type: "list", required: true },
      to: { label: "The list to move them into (e.g. Tea)", type: "text", required: true },
      from: { label: "The list they are in now (optional; worked out from the records when left blank)", type: "text" },
      carry_fields: { label: "Custom fields to bring along by name, so their values stay labelled in the new list (the move's preview names the ones it lacks)", type: "list" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /assets (and every record page: "No longer mine…" under its actions)
    group: "lifecycle",
    id: "platform:mark-gone", changes: "data",
    min_role: "grantable",
    label: "Mark as sold or given away",
    description:
      "Record that things are no longer the person's: sold, given away, parted out, traded, lost, or thrown out (how: sold, given away, parted out, converted, traded, lost, disposed of). They leave the lists and the totals and stay findable, with their history, photos and printed labels kept; nothing is deleted. Give the day (on, YYYY-MM-DD; today when left out), the price when it was sold, and who has it now (to) when it is known. Read the records first and pass their real ids and their kind.",
    icon: "hand-coins",
    scope: "workspace",
    invoke_handler: "platform.mark-gone",
    user_invokable: true,
    // platform:bring-back puts it back exactly, and is registered as its undo
    undoable: true,
    examples: ["I sold the old Ender 3 for $120", "I gave the drill press to my brother", "the blue kettle broke, I threw it out"],
    args_schema: {
      entity_kind: { label: "The kind of record (e.g. machines:machine)", type: "text", required: true },
      ids: { label: "The records, by id (read them first)", type: "list", required: true },
      how: { label: "How it left: sold, given away, parted out, converted, traded, lost, disposed of", type: "text", required: true },
      on: { label: "The day it left (YYYY-MM-DD; today when left out)", type: "text" },
      price: { label: "What it sold for", type: "number" },
      to: { label: "Who has it now", type: "text" },
      note: { label: "A note", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /assets (and every record page: Bring back, on the line of a thing that left)
    group: "lifecycle",
    id: "platform:bring-back", changes: "data",
    min_role: "grantable",
    label: "Bring back",
    description:
      "Things marked as sold or given away are the person's again: back in the lists and the totals, as they were before. For when something comes home, or was marked by mistake. Read the records first and pass their real ids and their kind.",
    icon: "undo-2",
    scope: "workspace",
    invoke_handler: "platform.bring-back",
    user_invokable: true,
    // platform:mark-gone with what each record said before is its undo
    undoable: true,
    examples: ["I got the drill press back", "I didn't sell the camera after all"],
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
      ids: { label: "The records, by id (read them first)", type: "list", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /machines (and every record page: "+ Link" on its Links panel)
    group: "organise",
    id: "platform:link-records", changes: "data",
    min_role: "member",
    run_by: "member",
    label: "Link two records",
    description:
      "Link one record to another, saying how they relate: a part and the project that uses it, a manual and the machine it is for. Pass the source and target as kind and id (read both records first) and relationship_kind, a short word for the link (uses, part-of, manual-for). The link shows on both records. The same two, the same way, once.",
    icon: "link",
    scope: "workspace",
    invoke_handler: "platform.link-records",
    user_invokable: true,
    // platform:unlink-records takes it away again; nothing else changes
    undoable: true,
    examples: ["link the M3 screws to the printer build project", "this manual is for the drill press"],
    args_schema: {
      source_kind: { label: "The first record's kind", type: "text", required: true },
      source_id: { label: "The first record's id", type: "text", required: true },
      target_kind: { label: "The record it links to: its kind", type: "text", required: true },
      target_id: { label: "The record it links to: its id", type: "text", required: true },
      relationship_kind: { label: "How they relate, in a word (uses, part-of, manual-for)", type: "text", required: true },
      notes: { label: "A note on the link", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /machines (and every record page: a link's note on its Links panel)
    group: "organise",
    id: "platform:edit-link", changes: "data",
    min_role: "member",
    run_by: "member",
    label: "Change a link's note",
    description:
      "Change the note on a link between two records. Pass the link's id (list_related gives each link with its id) and the new note; an empty note clears it.",
    icon: "link",
    scope: "workspace",
    invoke_handler: "platform.edit-link",
    user_invokable: true,
    // the note it had is put back
    undoable: true,
    examples: ["note on that link: only the left-hand spindle"],
    args_schema: {
      id: { label: "The link's id", type: "text", required: true },
      notes: { label: "The note (empty clears it)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /machines (and every record page: Unlink on its Links panel)
    group: "organise",
    id: "platform:unlink-records", changes: "data",
    min_role: "member",
    run_by: "member",
    label: "Unlink two records",
    description:
      "Take away a link between two records. Both records stay as they are; only the link goes. Pass the link's id (list_related gives each link with its id). A thing's link to its type is changed where the types are kept, not here.",
    icon: "unlink",
    scope: "workspace",
    invoke_handler: "platform.unlink-records",
    user_invokable: true,
    // the same link is made again, note and all
    undoable: true,
    examples: ["the screws aren't for that project any more", "unlink the manual from the lathe"],
    args_schema: {
      id: { label: "The link's id", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/automations
    group: "organise",
    id: "platform:add-wire", changes: "setup",
    min_role: "admin",
    label: "Set up an automation",
    description:
      "Set up an automation (a wire): when something happens to a kind of record, or on a schedule, or as a button on its records, run one action. Pass source_kind, action_id and the trigger; the action's arguments go in args. It is checked as the Automations screen checks one: an event something sends, a filter that reads, a trigger the kind can carry, an action that can run. Runs on the workspace, not a record.",
    icon: "workflow",
    scope: "workspace",
    invoke_handler: "platform.add-wire",
    user_invokable: true,
    // NOT undoable: an automation acts on its own later, so a person sees
    // the card before it is saved. Its undo (platform:remove-wire) is offered.
    undoable: false,
    examples: ["when stock of a part runs low, add it to the shopping list", "every Monday remind me to check the printers"],
    args_schema: {
      source_kind: { label: "The kind of record it watches or runs on (e.g. inventory:part)", type: "text", required: true },
      action_id: { label: "The action it runs (list_actions)", type: "text", required: true },
      trigger_type: { label: "When it runs: user-invoked (a button), event, on-create, on-update, on-delete or schedule", type: "text" },
      trigger_event: { label: "For trigger_type event: the event it listens for", type: "text" },
      trigger_schedule: { label: "For trigger_type schedule: an RRULE (F, required: true=WEEKLY;BYDAY=MO)", type: "text" },
      args: { label: "The action's arguments, as an object", type: "json" },
      filter: { label: "Only when the record matches this filter (field: value)", type: "json" },
      target: { label: "What it runs on: \"self\" (default), \"none\", or {rel, dir, kind} to reach a linked record", type: "json" },
      template: { label: "A message template, for actions that send one", type: "text" },
      label: { label: "For a button: what it says", type: "text" },
      ask: { label: "For a button: what it asks before it runs", type: "json" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/automations
    group: "organise",
    id: "platform:edit-wire", changes: "setup",
    min_role: "admin",
    label: "Change an automation",
    description:
      "Change an automation (a wire) by its id, which get_workspace_setup (automations) lists: its trigger, its action, its arguments, its filter or its target. Only the fields given change; it keeps its id and its history. Turning one on or off is platform:set-wire-enabled. Runs on the workspace, not a record.",
    icon: "workflow",
    scope: "workspace",
    invoke_handler: "platform.edit-wire",
    user_invokable: true,
    // NOT undoable, as add-wire; its undo puts the changed fields back.
    undoable: false,
    examples: ["make the low stock automation fire at 2 instead of 5", "point the restock wire at the Pantry list"],
    args_schema: {
      wire_id: { label: "The automation's id", type: "text", required: true },
      source_kind: { label: "The kind of record it watches or runs on (e.g. inventory:part)", type: "text" },
      action_id: { label: "The action it runs (list_actions)", type: "text" },
      trigger_type: { label: "When it runs: user-invoked (a button), event, on-create, on-update, on-delete or schedule", type: "text" },
      trigger_event: { label: "For trigger_type event: the event it listens for", type: "text" },
      trigger_schedule: { label: "For trigger_type schedule: an RRULE (F=WEEKLY;BYDAY=MO)", type: "text" },
      args: { label: "The action's arguments, as an object", type: "json" },
      filter: { label: "Only when the record matches this filter (field: value)", type: "json" },
      target: { label: "What it runs on: \"self\" (default), \"none\", or {rel, dir, kind} to reach a linked record", type: "json" },
      template: { label: "A message template, for actions that send one", type: "text" },
      label: { label: "For a button: what it says", type: "text" },
      ask: { label: "For a button: what it asks before it runs", type: "json" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/automations
    group: "organise",
    id: "platform:remove-wire", changes: "setup",
    min_role: "admin",
    label: "Remove an automation",
    description:
      "Remove an automation (a wire) by its id, which get_workspace_setup (automations) lists. Nothing it already did is undone; it only stops for good. To pause one instead, platform:set-wire-enabled. Runs on the workspace, not a record.",
    icon: "trash-2",
    scope: "workspace",
    invoke_handler: "platform.remove-wire",
    user_invokable: true,
    // NOT undoable, as add-wire; its undo sets the same automation up again.
    undoable: false,
    examples: ["delete the automation that emails me about the kiln"],
    args_schema: {
      wire_id: { label: "The automation's id", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/notification-audiences
    group: "more",
    id: "platform:set-notification-default",
    changes: "setup",
    // min_role "admin" is the rank floor; how a workspace's members hear its
    // urgent and high events is the owners' and admins' to set, as on the screen.
    min_role: "admin",
    label: "Set how members hear urgent or high events",
    description:
      "Choose the channel a workspace's members hear its urgent (or high) events on until they choose for themselves: email, Discord (for those who connected it) or phone and computer notifications, or none for the bell alone. A member who has set any channel in this workspace keeps their own choice. Owners and admins only.",
    icon: "bell",
    scope: "workspace",
    invoke_handler: "platform.set-notification-default",
    user_invokable: true,
    // Undo is setting it back: the answer names what it was.
    undoable: false,
    examples: ["send everyone urgent alerts by email", "members should get high priority notices on Discord", "stop emailing members urgent events by default"],
    args_schema: {
      priority: { label: "Which events: urgent or high", type: "text", required: true },
      channel: { label: "How members hear them: email, discord_dm, browser_push, or none for the bell alone", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/email
    group: "more",
    id: "platform:test-outbound-email", changes: "setup",
    // min_role "admin" is the rank floor; the handler applies the exact rule,
    // as the Email screen does.
    min_role: "admin",
    label: "Send a test email",
    description:
      "Send a test email through this workspace's own outbound mail, to your own account's address only, to check it works before a customer is emailed. Setting the mail provider up is done on the Email screen, never here. Owners and admins only.",
    icon: "mail",
    scope: "workspace",
    invoke_handler: "platform.test-outbound-email",
    user_invokable: true,
    // NOT undoable: a sent email cannot be taken back.
    undoable: false,
    examples: ["does my email setup work?", "send me a test email"],
    args_schema: {
      subject: { label: `Its subject line, to find it in your inbox (default: Test from ${productName()})`, type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /machines (and every record page: "Lend…" in its actions, RecordLoan)
    group: "lifecycle",
    id: "platform:lend", changes: "data",
    min_role: "grantable",
    label: "Lend it out",
    description:
      "Record that someone has things for now: who has it (holder, their name; or holder_id, someone on the People list), why (reason: repair, borrowed, or the person's words), the day it went (since, YYYY-MM-DD; today when left out), when it is due back (due_back, YYYY-MM-DD) and a note. Nothing else on the record changes: it keeps its place, which it returns to, and its state. Read the records first and pass their real ids and their kind.",
    icon: "hand-helping",
    scope: "workspace",
    invoke_handler: "platform.lend",
    user_invokable: true,
    // platform:return ends it, and is registered as its undo
    undoable: true,
    examples: ["I dropped the Dremel off with Sam to fix it", "lent the ladder to Sam until Friday", "my brother borrowed the drill"],
    args_schema: {
      entity_kind: { label: "The kind of record (e.g. machines:machine)", type: "text", required: true },
      ids: { label: "The records, by id (read them first)", type: "list", required: true },
      holder: { label: "Who has it, by name (or holder_id instead)", type: "text" },
      holder_id: { label: "Who has it, from the People list", type: "text" },
      reason: { label: "Why: repair, borrowed, or your own words", type: "text" },
      since: { label: "The day it went (YYYY-MM-DD; today when left out)", type: "text" },
      due_back: { label: "Due back (YYYY-MM-DD)", type: "text" },
      note: { label: "A note", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /machines (and every record page: "It's back" on the line of a thing lent out)
    group: "lifecycle",
    id: "platform:return", changes: "data",
    min_role: "grantable",
    label: "It's back",
    description:
      "Things lent out are back: the loan ends, and each is at its own place again in the state it was in. Back from a repair, say whether it was repaired (repaired: true or false) and what was done (work); a repair goes in its service log as \"Repaired by <who>\". Read the records first and pass their real ids and their kind.",
    icon: "undo-2",
    scope: "workspace",
    invoke_handler: "platform.return",
    user_invokable: true,
    // platform:lend with the loan each record had is its undo
    undoable: true,
    examples: ["Sam gave the Dremel back, the carriage clip is fixed", "the ladder is back"],
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
      ids: { label: "The records, by id (read them first)", type: "list", required: true },
      repaired: { label: "Back from a repair: was it repaired?", type: "boolean" },
      work: { label: "What was done, for its service log", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /machines
    group: "share", id: "platform:send-records", changes: "data", run_by: "member", min_role: "guest",
    label: "Send to another workspace", description: "Copy or move records into another workspace of your own. Preview the mapping first; complete items file directly and items needing a decision wait in the inbox. Read the records and send their real ids.",
    icon: "send", scope: "workspace", invoke_handler: "platform.send-records", user_invokable: true, undoable: false,
    args_schema: {
      entity_kind: { label: "Record kind", type: "text", required: true },
      ids: { label: "Record ids", type: "list", required: true },
      target_org: { label: "Target workspace id or slug", type: "text", required: true },
      connection_id: { label: `Connection id from send_targets for another ${productName()}`, type: "text" },
      collection: { label: "Target collection kind", type: "text" },
      create_matching: { label: "Create a matching collection if needed", type: "boolean" },
      add_fields: { label: "Source field labels to add in the target", type: "list" },
      placement: { label: "Use unplaced to explicitly leave the arrival unplaced", type: "text" },
      location: { label: "Target location id", type: "text" },
      mode: { label: "Copy or move", type: "text", required: true },
      dry_run: { label: "Preview only: answers the mapping in words, sends nothing", type: "boolean" },
      include_secrets: { label: "Include secrets", type: "boolean" },
      field_map: { label: "Field label to target field name, null to drop", type: "json" },
      duplicate: { label: "Update the earlier copy or make another", type: "text" },
      request_id: { label: "Stable send request id", type: "text" },
    }, version: "0.1.1",
  },
  {
    // UI-SCREEN: /machines
    group: "share", id: "platform:undo-send", changes: "data", run_by: "member", min_role: "guest", label: "Undo a workspace send",
    description: `Undo your workspace send. Across ${productName()} servers, undo the import there first, then restore the source here with restore_source.`,
    icon: "undo", scope: "workspace", invoke_handler: "platform.undo-send", user_invokable: true, undoable: false,
    args_schema: { id: { label: "Send id, from list_actions send_targets (sends)", type: "text", required: true }, restore_source: { label: "Restore the source here after connected import Undo", type: "boolean" } }, version: "0.1.1",
  },
  {
    // UI-SCREEN: /scan
    group: "share", id: "platform:export-send-file", changes: "data", run_by: "member", min_role: "guest",
    label: 'Download a send file', description: `Prepare a versioned send file with original documents for another ${productName()}. Download the returned link. A Move keeps its source until import confirmation.`,
    icon: "send", scope: "workspace", invoke_handler: "platform.export-send-file", user_invokable: true, undoable: false,
    args_schema: {
      entity_kind: {label: 'Record kind',type: 'text',required: true},
      ids: {label: 'Record ids',type: 'list',required: true},
      mode: {label: 'Copy or move',type: 'text',required: true},
      request_id: {label: 'Stable file request id',type: 'text'},
      dry_run: {label: 'Preview only',type: 'boolean'}
    }, version: "0.1.0",
  },
  {
    // UI-SCREEN: /scan
    group: "share", id: "platform:import-send-file", changes: "data", run_by: "member", min_role: "member",
    label: 'Import a send file', description: 'Preview the receiving collection and every field before importing an uploaded send file. Complete items file directly; decisions stay in the scan inbox. Returns a confirmation file.',
    icon: "send", scope: "workspace", invoke_handler: "platform.import-send-file", user_invokable: true, undoable: false,
    args_schema: {
      file_id: {label: 'Uploaded send file id',type: 'text',required: true},
      collection: {label: 'Receiving collection kind',type: 'text'},
      field_map: {label: 'Field label to target field name, null to drop',type: 'json'},
      create_matching: {label: 'Create a matching collection',type: 'boolean'},
      add_fields: {label: 'Source field labels to add',type: 'list'},
      placement: {label: 'Use unplaced or choose a location',type: 'text'},
      location: {label: 'Receiving location id',type: 'text'},
      duplicate: {label: 'Update or another copy',type: 'text'},
      request_id: {label: 'Stable import request id',type: 'text'},
      dry_run: {label: 'Preview only',type: 'boolean'}
    }, version: "0.1.0",
  },
  {
    // UI-SCREEN: /scan
    group: "share", id: "platform:confirm-send-file", changes: "data", run_by: "member", min_role: "guest",
    label: 'Confirm an imported send file', description: `Apply an import confirmation on the source ${productName()}. A Move removes only unchanged source items after the complete import is confirmed.`,
    icon: "send", scope: "workspace", invoke_handler: "platform.confirm-send-file", user_invokable: true, undoable: false,
    args_schema: {
      file_id: {label: 'Uploaded import confirmation file id',type: 'text',required: true},
      dry_run: {label: 'Preview only',type: 'boolean'}
    }, version: "0.1.0",
  },
  {
    // UI-SCREEN: /scan
    group: "share", id: "platform:undo-send-file-import", changes: "data", run_by: "member", min_role: "member",
    label: 'Undo a send file import', description: 'Remove imported items here, keeping later edits safe. Returns a return file offering a separate source restore for a Move.',
    icon: "send", scope: "workspace", invoke_handler: "platform.undo-send-file-import", user_invokable: true, undoable: false,
    args_schema: {
      id: {label: 'Import id',type: 'text',required: true},
      dry_run: {label: 'Preview only',type: 'boolean'}
    }, version: "0.1.0",
  },
  {
    // UI-SCREEN: /scan
    group: "share", id: "platform:restore-send-file-source", changes: "data", run_by: "member", min_role: "member",
    label: 'Restore the source of a file Move', description: `Apply a return file on the source ${productName()} after the target import was undone. Restores only the source of that confirmed Move.`,
    icon: "send", scope: "workspace", invoke_handler: "platform.restore-send-file-source", user_invokable: true, undoable: false,
    args_schema: {
      file_id: {label: 'Uploaded return file id',type: 'text',required: true},
      dry_run: {label: 'Preview only',type: 'boolean'}
    }, version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/sharing (and every record page: "Give to…")
    group: "share",
    id: "platform:offer-to", changes: "setup",
    min_role: "grantable",
    label: "Give to someone you share with",
    description:
      "Offer records to a person this workspace is shared with (or, from a workspace of your own, to someone who shared with you): they arrive in that person's scan inbox, where they take them, pass, or leave them for later. Taken, a record here becomes 'Given away to <them>' with its history kept. Name the person (to) as their name or the share's id. Read the records first and pass their real ids and their kind.",
    icon: "gift",
    scope: "workspace",
    invoke_handler: "platform.offer-to",
    user_invokable: true,
    // it reaches another person's inbox, which no undo here can take back
    undoable: false,
    examples: ["give the spare PSU to Sam", "offer these three printers to Vince"],
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
      ids: { label: "The records, by id (read them first)", type: "list", required: true },
      to: { label: "Who to offer them to: the person's name, or the share's id", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /machines (and every record page: "Share with…", and a list's selection bar)
    group: "share",
    id: "platform:share-with", changes: "setup",
    min_role: "grantable",
    label: "Share with someone",
    description:
      "Put records in a share with a person, so a copy of each appears in their shared workspace and keeps in step. Records already shared with them are left as they are. Name the person (with) as their name or the share's id, someone already shared with. Sharing with a new email address brings a new person in, so the person does that themselves under Share with…: offer to open it, never pass an email here. For a whole list, pass collection: true and entity_kind from list_record_kinds, without ids. Otherwise read the records first and pass their real ids and their kind.",
    icon: "share-2",
    scope: "workspace",
    invoke_handler: "platform.share-with",
    user_invokable: true,
    // it reaches another person's workspace, who may already have seen it:
    // platform:stop-sharing takes the copies back, but an assistant asks first
    undoable: false,
    examples: ["share the Voron with Vince", "let Sam see these three drills", "share 3D Printers with sam@example.com"],
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
      ids: { label: "The records, by id (read them first)", type: "list" },
      collection: { label: "Share the whole collection, including future records (owner or admin)", type: "boolean" },
      with: { label: "Who to share them with: the person's name or the share's id (someone already shared with)", type: "text", required: true },
    },
    version: "0.3.0",
  },
  {
    // UI-SCREEN: /machines (and every record page: "Shared with <them>", Stop)
    group: "more",
    id: "platform:stop-sharing", changes: "setup",
    min_role: "grantable",
    label: "Stop sharing with someone",
    description:
      "Take records out of a share with a person: their copies leave that person's shared workspace. A record a share brings in by a rule (a whole collection, or lent to them) is kept out by name. Name the person (with) as their name or the share's id. For a whole list, pass collection: true and entity_kind from list_record_kinds, without ids, to remove only its whole-collection rule; records shared by other rules or picks stay shared. Otherwise read the records first and pass their real ids and their kind.",
    icon: "share-2",
    scope: "workspace",
    invoke_handler: "platform.stop-sharing",
    user_invokable: true,
    // it changes what another person's workspace holds: platform:share-with
    // puts it back, but an assistant asks first
    undoable: false,
    examples: ["stop sharing the Voron with Vince"],
    args_schema: {
      entity_kind: { label: "The kind of record", type: "text", required: true },
      ids: { label: "The records, by id (read them first)", type: "list" },
      collection: { label: "Remove the whole-collection rule (owner or admin)", type: "boolean" },
      with: { label: "Who to stop sharing them with: the person's name, or the share's id", type: "text", required: true },
    },
    version: "0.2.0",
  },
  {
    // UI-SCREEN: /me/communication (the device list's Send a test)
    group: "more",
    id: "platform:test-push-device", changes: "setup",
    // Anyone, on their own device only: the handler finds the device by the caller.
    min_role: "guest",
    label: "Send a test notification to a device",
    description:
      "Send a test push to one of your own phones or computers, which proves the whole path: this server's key, the push service, the device and its permission. Says whether it arrived and, if not, why. Device ids come from the notification delivery read.",
    icon: "bell",
    scope: "workspace",
    invoke_handler: "platform.test-push-device",
    // Anyone in the workspace, on their own devices: the page gates it the same way.
    run_by: "member",
    user_invokable: true,
    // A push, once sent, is not taken back; the assistant asks the person first.
    undoable: false,
    examples: ["send a test notification to my iPhone", `check my phone gets ${productName()} notifications`],
    args_schema: {
      device_id: { label: "The device, by id", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /me/communication (the device list's Remove)
    group: "more",
    id: "platform:remove-push-device", changes: "setup",
    min_role: "guest",
    label: "Stop notifications on a device",
    description:
      `Remove one of your own phones or computers from the devices ${productName()} sends notifications to. It is turned on again on the device itself. Device ids come from the notification delivery read.`,
    icon: "bell-off",
    scope: "workspace",
    invoke_handler: "platform.remove-push-device",
    // Anyone in the workspace, on their own devices: the page gates it the same way.
    run_by: "member",
    user_invokable: true,
    // Only the device can subscribe itself again.
    undoable: false,
    examples: ["stop notifications on my old laptop"],
    args_schema: {
      device_id: { label: "The device, by id", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /suggestions (and every record page: "2 suggested edits by Vince")
    group: "more",
    id: "platform:accept-suggestions", changes: "data",
    min_role: "grantable",
    label: "Accept suggested edits",
    description:
      "Accept edits someone you share with suggested on your records: each changes your record to their value, and your history names them. Pass the suggestions' ids, or a record (entity_kind and entity_id) to accept everything suggested on it, or from (a person's name) for everything they suggested. Where you changed the same field since, accepting puts their value in place of yours. List them first with the suggestions read.",
    icon: "check",
    scope: "workspace",
    invoke_handler: "platform.accept-suggestions",
    user_invokable: true,
    // platform:reopen-suggestions puts each record back and the edit waits again
    undoable: true,
    examples: ["accept Vince's suggestions on the CR-10", "accept all of Sam's edits"],
    args_schema: {
      ids: { label: "The suggestions, by id", type: "list" },
      entity_kind: { label: "A record's kind, to decide everything suggested on it", type: "text" },
      entity_id: { label: "That record's id", type: "text" },
      from: { label: "A person's name, to decide everything they suggested", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /suggestions (and every record page: Reject on a suggested edit)
    group: "more",
    id: "platform:reject-suggestions", changes: "data",
    min_role: "grantable",
    label: "Reject suggested edits",
    description:
      "Turn down edits someone you share with suggested on your records: your records stay as they are, and their copies go back to what yours say. Pass the suggestions' ids, or a record (entity_kind and entity_id), or from (a person's name). List them first with the suggestions read.",
    icon: "x",
    scope: "workspace",
    invoke_handler: "platform.reject-suggestions",
    user_invokable: true,
    // platform:reopen-suggestions makes each wait again
    undoable: true,
    examples: ["reject Vince's edit to the Voron's colour"],
    args_schema: {
      ids: { label: "The suggestions, by id", type: "list" },
      entity_kind: { label: "A record's kind, to decide everything suggested on it", type: "text" },
      entity_id: { label: "That record's id", type: "text" },
      from: { label: "A person's name, to decide everything they suggested", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /suggestions (the Undo after Accept or Reject)
    group: "more",
    id: "platform:reopen-suggestions", changes: "data",
    min_role: "grantable",
    label: "Put suggested edits back to waiting",
    description:
      "Undo accepting or rejecting suggested edits: an accepted one puts the record back to what it said before, and each waits for a decision again. Pass the suggestions' ids.",
    icon: "undo-2",
    scope: "workspace",
    invoke_handler: "platform.reopen-suggestions",
    user_invokable: false,
    // accepting or rejecting again, as each was, is its undo
    undoable: true,
    examples: ["undo accepting Vince's edits"],
    args_schema: {
      ids: { label: "The suggestions, by id", type: "list", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /suggestions ("Added to the share": Take)
    group: "more",
    id: "platform:take-additions", changes: "data",
    min_role: "grantable",
    label: "Take what someone added to a share",
    description:
      "Take things someone you share with added to the shared workspace into your own collection: each becomes your record, stays shared with them, and theirs becomes its copy. Pass the additions' ids from the suggestions read.",
    icon: "inbox",
    scope: "workspace",
    invoke_handler: "platform.take-additions",
    user_invokable: true,
    // it makes records here and changes the other person's copy; an assistant asks first
    undoable: false,
    examples: ["take the PSU Vince added"],
    args_schema: { ids: { label: "The additions, by id", type: "list", required: true } },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /suggestions ("Added to the share": Leave)
    group: "more",
    id: "platform:leave-additions", changes: "data",
    min_role: "grantable",
    label: "Leave what someone added to a share",
    description: "Leave things someone you share with added to the shared workspace where they are, without taking them into your collection. Pass the additions' ids from the suggestions read.",
    icon: "x",
    scope: "workspace",
    invoke_handler: "platform.leave-additions",
    user_invokable: true,
    // nothing to put back: the thing stays in their shared workspace either way
    undoable: false,
    examples: ["leave the cables Vince added"],
    args_schema: { ids: { label: "The additions, by id", type: "list", required: true } },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/modules
    group: "more",
    id: "platform:disable-module", changes: "setup",
    min_role: "grantable",
    label: "Turn off a feature",
    description:
      `Turn one of ${productName()}'s features off for this workspace: its screens leave the navigation. Records already stored are kept and come back if it is turned on again, but the fields and automations that came WITH the feature are cleared out. Refuses when another feature in use depends on it, and says which. Runs on the workspace, not a record.`,
    icon: "toggle-left",
    scope: "workspace",
    invoke_handler: "platform.disable-module",
    user_invokable: true,
    // the records survive, but the feature's own field defs and automations are
    // removed with it, and turning it back on does not remember how they were set
    undoable: false,
    examples: ["turn off shipments", "I don't use maintenance, take it out"],
    args_schema: {
      module: { label: "The feature, by its name in the app (e.g. Shipments)", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /bundles (Remove, on an installed bundle)
    group: "organise",
    id: "platform:remove-bundle", changes: "setup",
    min_role: "admin",
    label: "Remove a bundle",
    description:
      "Remove something this workspace added as a bundle, as a whole: Yarn, Groceries, Board Games and the like, a table with its own fields, views and automations. This, not disable-module, is how a table that came from a bundle goes; name it the way the app does (\"Yarn\"). With delete_records the bundle's tables and every record in them are deleted, permanently; use it only when the person says the records should go too (\"as a whole\", \"and everything in it\"). Without it the fields, automations and views go and the tables keep their records. Runs on the workspace, not a record.",
    icon: "package-minus",
    scope: "workspace",
    invoke_handler: "platform.remove-bundle",
    user_invokable: true,
    // Deleting records cannot be put back, and even a removal that keeps them
    // takes the fields and automations away: a person confirms either.
    undoable: false,
    examples: ["remove yarn and everything in it", "get rid of the groceries bundle", "uninstall board games but keep my games"],
    args_schema: {
      bundle: { label: "The bundle", type: "text", required: true },
      delete_records: { label: "Delete its tables and their records too", type: "boolean" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /bundles (Install, on a bundle in the catalog)
    group: "organise",
    id: "platform:install-bundle", changes: "setup",
    min_role: "admin",
    label: "Install a bundle",
    description:
      "Install a bundle from this deployment's catalog: Yarn, Groceries, Board Games and the like, a ready-made table with its fields, views and automations. Name it as the catalog does. It turns on any feature it needs. Its optional parts start as the bundle sets them unless you name the ones wanted. Only the catalog's bundles; a bundle file someone has is installed on the Bundles screen. Runs on the workspace, not a record.",
    icon: "package-plus",
    scope: "workspace",
    invoke_handler: "platform.install-bundle",
    user_invokable: true,
    // It changes the workspace's shape (features turned on, tables, fields,
    // automations): a person confirms the card. Removing it is
    // platform:remove-bundle.
    undoable: false,
    examples: ["install the yarn bundle", "add groceries to my workspace", "set me up to track board games"],
    args_schema: {
      bundle: { label: "The bundle, by its catalog name", type: "text", required: true },
      features: { label: "Its optional parts to include, by name, comma separated (default: the bundle's own choice)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /bundles (the optional parts of an installed bundle)
    group: "organise",
    id: "platform:set-bundle-features", changes: "setup",
    min_role: "admin",
    label: "Turn a bundle's optional parts on or off",
    description:
      "Turn optional parts of an installed bundle on or off, by name: Embroidery for Sewing, and the like. A part turned off keeps any table that holds records; only an empty one goes. Runs on the workspace, not a record.",
    icon: "toggle-right",
    scope: "workspace",
    invoke_handler: "platform.set-bundle-features",
    user_invokable: true,
    // A person confirms; the way back (the parts as they were) is offered after.
    undoable: false,
    examples: ["turn on embroidery for sewing", "I don't need the wishlist part of board games"],
    args_schema: {
      bundle: { label: "The installed bundle", type: "text", required: true },
      turn_on: { label: "Parts to turn on, by name, comma separated", type: "text" },
      turn_off: { label: "Parts to turn off, by name, comma separated", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /bundles (History, on an installed bundle)
    group: "organise",
    id: "platform:revert-bundle", changes: "setup",
    min_role: "admin",
    label: "Put a bundle back to an earlier version",
    description:
      "Put an installed bundle back the way it was before its last change (an update, a part turned on or off), or to a saved version by its id. The card says which version and when it was saved. Records are kept; the version it replaces is saved, so this can be reverted too. Runs on the workspace, not a record.",
    icon: "history",
    scope: "workspace",
    invoke_handler: "platform.revert-bundle",
    user_invokable: true,
    undoable: false,
    examples: ["undo the yarn update", "put groceries back how it was yesterday"],
    args_schema: {
      bundle: { label: "The installed bundle", type: "text", required: true },
      snapshot_id: { label: "A saved version's id (default: the one before its last change)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/presentation (a list's settings: "Scans that fit no list land here")
    group: "organise",
    id: "platform:set-scan-fallback", changes: "setup",
    min_role: "admin",
    label: "Choose where scans that fit no list land",
    description:
      "Make one list its feature's catch-all for scans: a scan that matches no list in particular lands there, to be told apart by its category. One per feature; naming a new one replaces the old. Runs on the workspace, not a record.",
    icon: "inbox",
    scope: "workspace",
    invoke_handler: "platform.set-scan-fallback",
    user_invokable: true,
    // Undone by naming the list it was before (offered after).
    undoable: false,
    examples: ["scans that don't fit anywhere should go to Misc parts", "make Shop supplies the catch-all"],
    args_schema: {
      list: { label: "The list, by its name", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: / (the dashboard's Arrange)
    group: "organise",
    id: "platform:arrange-dashboard", changes: "setup",
    min_role: "admin",
    label: "Arrange the dashboard",
    description:
      "Arrange this workspace's dashboard: hide or show a card or a section, put some first, make a card wide or normal. Name a section as the dashboard does (up next, at a glance, your views, from your scanner, recent activity) and a card by its feature (Machines, Purchases). Members never see this dashboard. Undo puts the whole arrangement back. Runs on the workspace, not a record.",
    icon: "layout-dashboard",
    scope: "workspace",
    invoke_handler: "platform.arrange-dashboard",
    user_invokable: true,
    // Only the arrangement changes, and Undo puts back exactly what was there.
    undoable: true,
    examples: ["hide recent activity on the dashboard", "put machines first", "make the purchases card wide"],
    args_schema: {
      hide: { label: "Cards or sections to hide, comma separated", type: "text" },
      show: { label: "Cards or sections to show, comma separated", type: "text" },
      first: { label: "Cards or sections to put first, in this order, comma separated", type: "text" },
      wide: { label: "Cards to make wide, comma separated", type: "text" },
      normal: { label: "Cards to make normal width, comma separated", type: "text" },
      restore: { label: "A whole arrangement to put back, as Undo saved it (JSON)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/backup (Install a blueprint)
    group: "organise",
    id: "platform:install-blueprint", changes: "setup",
    min_role: "admin",
    label: "Install a blueprint",
    description:
      "Install a blueprint, a whole workspace's setup exported from another workspace (its features, bundles, lists, fields, automations, views and public pages), pasted as its JSON. The card lists what it will turn on and create, public pages included, before anything happens. Runs on the workspace, not a record.",
    icon: "layers",
    scope: "workspace",
    invoke_handler: "platform.install-blueprint",
    user_invokable: true,
    // It reshapes the workspace and can publish pages: the card is the yes.
    undoable: false,
    examples: ["install this blueprint: {...}", "set this workspace up like my other one (here's its export)"],
    args_schema: {
      blueprint: { label: "The blueprint, its exported JSON", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: / (an app's account menu: Do more with Cobblr, bring my records over)
    group: "organise",
    id: "platform:import-app", changes: "setup",
    min_role: "admin",
    label: "Copy an app's records into this workspace",
    description:
      `Copy the records of one of your own apps (each a workspace of its own) into this workspace: its table and fields are set up here, then every record is copied. The app keeps its records; nothing there changes. Name the app as it is called, or its address. You must be an owner or admin of both. Runs on the workspace, not a record.`,
    icon: "download",
    scope: "workspace",
    invoke_handler: "platform.import-app",
    user_invokable: true,
    // It copies records into this workspace from another: the card is the yes.
    undoable: false,
    examples: ["bring my yarn app's records over", "copy everything from my yarn app into here"],
    args_schema: {
      from: { label: "The app, by its name or address", type: "text", required: true },
    },
    version: "0.1.0",
  },
  // UI-SCREEN: /configuration/presentation (and the pencil on every record's Contents heading)
  {
    group: "organise",
    id: "platform:rename-contents", changes: "setup",
    min_role: "grantable",
    label: "Rename what a list calls the things inside its records",
    description:
      "Change the word one kind of record uses for what is inside it: a computer's Contents become Parts, a bag's become In the bag, a toolbox's Tools. Every record of that kind (or list) shares the word, and it shows on the panel, in its messages and in answers about what is inside. Give an empty word to put the default back. Runs on the workspace, not a record.",
    icon: "text-cursor-input",
    scope: "workspace",
    invoke_handler: "platform.rename-contents",
    user_invokable: true,
    undoable: true,
    examples: ["call what is inside my computers parts", "the backpack's contents should say In the bag"],
    args_schema: {
      target: { label: "Which kind of record or list, by what it is called now (e.g. Computers)", type: "text", required: true },
      word: { label: "What to call what is inside (e.g. Parts); empty puts the default back", type: "text" },
    },
    version: "0.1.0",
  },
  // UI-SCREEN: /configuration/presentation
  // ACTION-TEMPLATE: kernel actions live in this registry, outside the module scaffolder.
  {
    group: "organise",
    id: "platform:set-list-presentation", changes: "setup",
    min_role: "grantable",
    label: "Change how a list is presented",
    description: "Change how a list is shown: its icon, visibility in navigation, navigation order, grouping heading, and whether it appears at the top level. It also sets the word for one record and for several (item_noun); to rename the list itself, use platform:rename-thing. Name the list as it is called now or give its kind ID. Omitted settings stay as they are. Empty text or null restores a default, and null navigation order restores default ordering. Undo puts the changed settings back. Runs on the workspace.",
    icon: "sliders-horizontal",
    scope: "workspace",
    invoke_handler: "platform.set-list-presentation",
    user_invokable: true,
    undoable: true,
    examples: ["hide Bookshelf from navigation", "give my tools the wrench icon", "call one thing in Bookshelf a book and several books", "nest Spices under Inventory"],
    args_schema: {
      target: { label: "The list, by its current name or kind ID", type: "text" },
      entity_kind: { label: "Kind ID, instead of a list name", type: "text" },
      icon: { label: "Icon name, such as wrench; empty restores the default", type: "text" },
      hidden: { label: "Hide from navigation", type: "boolean" },
      nav_order: { label: "Navigation order; lower comes first, null restores the default", type: "number" },
      group_label: { label: "Heading over this list's categories; empty restores the default", type: "text" },
      top_level: { label: "Show as a top-level entry; false nests under its module, null restores the default", type: "boolean" },
      item_noun: { label: "What one record is called; empty restores the default", type: "text" },
      item_noun_plural: { label: "What several records are called; empty derives it from the singular", type: "text" },
    },
    version: "0.1.0",
  },
  {
    group: "organise",
    // UI-SCREEN: /configuration/presentation (edit the singular and plural labels)
    id: "platform:rename-thing", changes: "setup",
    min_role: "grantable",
    label: "Rename what a list is called",
    description:
      "Rename a list or a kind of record: Parts becomes Spools, Machines becomes Printers. It renames the LABEL only, everywhere it is shown (navigation, headings, buttons); nothing recorded moves and no id changes. Give both the singular and the plural when they are not the plain +s. Runs on the workspace, not a record. Use get_workspace_setup to see what the lists are called now.",
    icon: "text-cursor-input",
    scope: "workspace",
    invoke_handler: "platform.rename-thing",
    user_invokable: true,
    // a label, and nothing but a label: renaming it back is the whole undo
    undoable: true,
    examples: ["call my parts spools", "rename Machines to Printers", "we call those bins totes"],
    args_schema: {
      target: { label: "What to rename, by what it is called now (e.g. Parts)", type: "text", required: true },
      name: { label: "What to call one of them (e.g. Spool)", type: "text", required: true },
      plural: { label: "What to call several (e.g. Spools). Defaults to the name plus s", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /configuration/presentation (and every record page: "+ Lending", "+ Stock" under its details)
    group: "organise",
    id: "platform:set-faces", changes: "setup",
    min_role: "grantable",
    label: "Turn a section on or off for a list",
    description:
      "Show or hide a kind of detail for every record of a kind or list: stock (counts and reorder), perishable (use-by dates), serialized (serial numbers), maintained (service), lendable (lending) or container (what is inside). Name the list (target, as it is called now) or pass its kind (entity_kind). on and off are lists of those names; clear hands a choice back to the list's own fields. Nothing recorded is deleted: a section turned off keeps its values for when it comes back.",
    icon: "layers",
    scope: "workspace",
    invoke_handler: "platform.set-faces",
    user_invokable: true,
    // setting the choices back as they were is the undo
    undoable: true,
    examples: ["track lending on my tools", "turn on use-by dates for the pantry", "stop showing stock on the bookshelf"],
    args_schema: {
      target: { label: "The list, by what it is called now (e.g. Tools)", type: "text" },
      entity_kind: { label: "Or the kind of record (e.g. machines:machine)", type: "text" },
      on: { label: "Sections to turn on (stock, perishable, serialized, maintained, lendable, container)", type: "list" },
      off: { label: "Sections to turn off", type: "list" },
      clear: { label: "Sections to hand back to the list's own fields", type: "list" },
    },
    version: "0.1.0",
  },
  {
    group: "more",
    id: "platform:promote-category", changes: "setup",
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
      from: { label: "The list the category is in now (e.g. pantry)", type: "text", required: true },
      category: { label: "The category to pull out (e.g. Spices)", type: "text", required: true },
      display_name: { label: "What to call the new list (defaults to the category)", type: "text" },
      instance_name: { label: "Short name for it (lowercase; derived from the display name if omitted)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    group: "more",
    id: "platform:demote-category", changes: "setup",
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
      list: { label: "The list to fold away (e.g. spices)", type: "text", required: true },
      into: { label: "The list it goes back into (e.g. pantry)", type: "text", required: true },
      category: { label: "The category to stamp them with (defaults to the list's name)", type: "text" },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: / (the workspace switcher's Rename, in the header of every screen)
    group: "organise",
    id: "platform:rename-workspace", changes: "setup",
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
      name: { label: "What to call it", type: "text", required: true },
    },
    version: "0.1.0",
  },
  {
    group: "more",
    // UI-SCREEN: /configuration/general (Simple mode toggle)
    id: "platform:set-simple-mode", changes: "setup",
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
      on: { label: "True for simple, false for everything", type: "boolean", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /fields
    group: "organise",
    id: "platform:set-field-preset", changes: "setup",
    min_role: "grantable",
    label: "Switch a set of fields on or off",
    description:
      "Switch on a named SET of fields the workspace already defines, in one go, across everything they apply to: 'provenance' puts where each thing came from, when, and what it cost onto every physical thing the workspace tracks, now and in future. Only a set that exists (get_workspace_setup lists them); this never makes a new field, so 'track a colour on everything' is platform:add-field with entity_kind @physical, not a preset called colour. Switching a set off takes the fields away and KEEPS anything already recorded in them, which comes back if it goes on again. Runs on the workspace, not a record.",
    icon: "layers",
    scope: "workspace",
    invoke_handler: "platform.set-field-preset",
    user_invokable: true,
    // symmetric, and nothing recorded is lost either way
    undoable: true,
    examples: ["track where my things came from", "turn on provenance", "stop tracking what things cost"],
    args_schema: {
      preset: { label: "Which set (e.g. provenance)", type: "text", required: true },
      on: { label: "True to switch it on, false to take it away", type: "boolean", required: true },
    },
    version: "0.1.0",
  },
  {
    // UI-SCREEN: /wires
    group: "more",
    id: "platform:set-wire-enabled", changes: "setup",
    min_role: "grantable",
    label: "Turn an automation on or off",
    description:
      "Switch one automation (wire) on or off by its id — find the id with get_workspace_setup (automations). Toggling only stops or restarts behavior the user already set up; platform:add-wire sets one up and platform:edit-wire changes one. Runs on the workspace, not a record.",
    icon: "toggle-left",
    scope: "workspace",
    invoke_handler: "platform.set-wire-enabled",
    user_invokable: true,
    // a toggle: setting it back is the whole undo
    undoable: true,
    examples: ["stop the low stock wire from firing", "turn that automation back on"],
    args_schema: {
      wire_id: { label: "The automation's id", type: "text", required: true },
      enabled: { label: "On (true) or off (false)", type: "boolean", required: true },
    },
    version: "0.1.0",
  },
  // ── Services (service-confirm.ts). The yes on a waiting job's card. ──
  //
  // wire_only keeps it off the assistant's rail: a job that waits for a
  // person is a person's to start, never the assistant's own. The handler
  // applies the exact rule (the person who asked, or an owner or admin for an
  // automation's job) and checks the job is still what was shown.
  // ── Services (#4034): a wire that runs a capability. The wire door stamps
  // the job; consent is the gate's, so a physical capability waits in
  // awaiting_confirm for a person however the wire was set up.
  {
    // UI-SCREEN: /wires (the wire composer's "No record" list, read from /wire-actions)
    group: "more",
    id: "platform:invoke-service", changes: "data",
    min_role: "admin",
    label: "Run a service",
    description:
      "Run one of the workspace's services (a slicer, a design service, a detector) with the input set here. {{event.…}} values in the input are filled from the event. A job that follows another service job is counted as its next step. Anything that acts in the world waits for a person's yes.",
    icon: "workflow",
    scope: "workspace",
    invoke_handler: "platform.invoke-service",
    user_invokable: false,
    undoable: false,
    args_schema: {
      capability: { label: "Service", type: "text", required: true, picker: "service-capability" },
      input: { label: "Input", type: "json", schema_from: "capability" },
    },
    version: "0.1.0",
    wire_only: true,
    recordless: true,
  },
  {
    // UI-SCREEN: /me/notifications   the job's card, and the bell; a missed one waits there
    group: "more",
    id: "platform:confirm-service-job", changes: "data", run_by: "requester",
    min_role: "member",
    label: "Start a service job",
    description:
      "Say yes to a service job that is waiting for a person: it starts exactly as it was asked. Pressed from the job's card by the person who asked for it, or by an owner or admin for a job an automation started.",
    icon: "check",
    scope: "workspace",
    invoke_handler: "platform.confirm-service-job",
    user_invokable: false,
    undoable: false,
    args_schema: {
      job_id: { label: "The job", type: "text", required: true },
    },
    version: "0.1.0",
    wire_only: true,
  },
  // ── The Services supervisor's buttons (service-supervisor.ts): pressed from
  // a stuck run's notice, by the person whose run it is, or an owner or admin
  // for a run an automation started. Never the assistant's to press.
  {
    group: "more",
    id: "platform:retry-service-job", changes: "data", run_by: "requester",
    min_role: "member",
    label: "Retry a service step",
    description:
      "Run a step of a service run that failed or stopped again, as a new job beside it, with exactly the same input. For something that acts in the world, pressing it is your yes.",
    icon: "rotate-ccw",
    scope: "workspace",
    invoke_handler: "platform.retry-service-job",
    user_invokable: false,
    undoable: false,
    args_schema: { job_id: { label: "The step", type: "text", required: true } },
    version: "0.1.0",
    wire_only: true,
  },
  {
    group: "more",
    id: "platform:skip-service-job", changes: "data", run_by: "requester",
    min_role: "member",
    label: "Skip a service step",
    description:
      "Go on with a service run without the answer of a step that failed: the next step starts as if it had finished with nothing to say. Offered only where the next step can do without it.",
    icon: "skip-forward",
    scope: "workspace",
    invoke_handler: "platform.skip-service-job",
    user_invokable: false,
    undoable: false,
    args_schema: { job_id: { label: "The step", type: "text", required: true } },
    version: "0.1.0",
    wire_only: true,
  },
  {
    group: "more",
    id: "platform:cancel-service-run", changes: "data", run_by: "requester",
    min_role: "member",
    label: "Cancel a service run",
    description: "Stop a service run: every step still waiting or running is cancelled, and nothing more starts from it.",
    icon: "x",
    scope: "workspace",
    invoke_handler: "platform.cancel-service-run",
    user_invokable: false,
    undoable: false,
    args_schema: { job_id: { label: "The run", type: "text", required: true } },
    version: "0.1.0",
    wire_only: true,
  },
  // ── Approvals (approvals.ts). The two buttons on an approver's card. ──
  //
  // min_role "admin" is the rank floor the invoke route enforces; the handler
  // then applies the EXACT rule (owner/admin, never editor) because deciding
  // what another person may do is governance, and an approval must never be
  // able to grant the power to approve. wire_only keeps them off the
  // assistant's rail: a decision about a person is not the assistant's to
  // make, and `user_invokable: false` keeps them out of the grantable list.
  {
    // UI-SCREEN: /configuration/permissions
    group: "more",
    id: "platform:approve-request", changes: "setup",
    min_role: "admin",
    label: "Approve a request",
    description:
      "Answer yes to a member's request for a capability or a bundle install. Gives exactly what was asked, to that person, and nothing else; the person is told and can finish what they started. Pressed from the request card by a workspace owner or admin.",
    icon: "check",
    scope: "workspace",
    invoke_handler: "platform.approve-request",
    user_invokable: false,
    // a granted capability can be revoked in the matrix; an installed bundle
    // can be uninstalled. The yes itself is a decision, not a record.
    undoable: false,
    args_schema: {
      request_id: { label: "The request", type: "text", required: true },
      note: { label: "A word for the person (optional)", type: "text" },
    },
    version: "0.1.0",
    wire_only: true,
  },
  {
    // UI-SCREEN: /configuration/permissions
    group: "more",
    id: "platform:deny-request", changes: "setup",
    min_role: "admin",
    label: "Decline a request",
    description:
      "Answer no to a member's request. Nothing changes; the person is told, with the note if one was given. Pressed from the request card by a workspace owner or admin.",
    icon: "x",
    scope: "workspace",
    invoke_handler: "platform.deny-request",
    user_invokable: false,
    undoable: false,
    args_schema: {
      request_id: { label: "The request", type: "text", required: true },
      note: { label: "Why (optional)", type: "text" },
    },
    version: "0.1.0",
    wire_only: true,
  },
  // The two buttons on the card an assistant's held delete sends its person
  // (ai-held-changes.ts). Only that person can press them; wire-only and not
  // grantable, so nothing but the card reaches them.
  {
    // UI-SCREEN: /me/notifications   the held change's card, and the bell; a missed one waits there
    group: "more",
    id: "platform:confirm-held-change", changes: "data", run_by: "requester",
    min_role: "member",
    label: "Delete what an assistant asked to delete",
    description:
      "Say yes to a delete an assistant asked for over MCP. It runs once, as you, under your own permissions. Pressed from the card; a card more than a day old deletes nothing.",
    icon: "trash-2",
    scope: "workspace",
    invoke_handler: "platform.confirm-held-change",
    user_invokable: false,
    undoable: false,
    args_schema: { change_id: { label: "The held change", type: "text", required: true } },
    version: "0.1.0",
    wire_only: true,
  },
  {
    // UI-SCREEN: /me/notifications   the held change's card, and the bell; a missed one waits there
    group: "more",
    id: "platform:keep-held-change", changes: "data", run_by: "requester",
    min_role: "member",
    label: "Keep what an assistant asked to delete",
    description: "Say no to a delete an assistant asked for over MCP. Nothing is deleted and the card stops asking.",
    icon: "x",
    scope: "workspace",
    invoke_handler: "platform.keep-held-change",
    user_invokable: false,
    undoable: false,
    args_schema: { change_id: { label: "The held change", type: "text", required: true } },
    version: "0.1.0",
    wire_only: true,
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
/** Whether this platform action changes the workspace's setup rather than
 *  its records (`changes`). False for an action that is not the platform's. */
export function platformActionChangesWorkspace(actionId: string): boolean {
  return PLATFORM_ACTIONS.find((a) => a.id === actionId)?.changes === "setup";
}

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
// Plain fields, not parameter properties: the coverage generator imports this
// file under Node's type stripping, which has no parameter properties.
export class ActionRoleFloorError extends Error {
  readonly actionId: string;
  readonly requiredRole: OrgRoleName;
  readonly actingRole: string | null;
  constructor(actionId: string, requiredRole: OrgRoleName, actingRole: string | null) {
    super(`The ${actionId} action requires the ${requiredRole} role.`);
    this.name = "ActionRoleFloorError";
    this.actionId = actionId;
    this.requiredRole = requiredRole;
    this.actingRole = actingRole;
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
