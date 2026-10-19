import { z } from "zod";
import { ActionGroupReference } from "@cobblr/platform-contract/action-groups-schema";
import { EntityFieldRole, FaceSchema, FieldRoleSchema } from "@cobblr/platform-contract/entity-fields";
import { ORG_ROLES, roleHoldsEveryCapability } from "@cobblr/platform-contract/org-roles";
import { SERVICE_EFFECTS } from "@cobblr/platform-contract/services";

// ─────────────────────── Pillar B: actions ─────────────────────────
//
// Modules declare what they can do TO entities. Actions list the
// kinds they apply to — either by explicit ID, or by predicate
// ({ any: true } / { hasFieldRole: 'title' }).

// ─────────────────────── Wire target (Q1) ─────────────────────────
//
// What the wire fires the action on. Two forms:
//   - "self" (or omitted) — action runs on the source entity. The
//     no-target-declared default; preserves today's fire-on-source
//     behaviour.
//   - { rel, dir?, kind? } — action runs on entities discovered by
//     walking entity_pairings from the source. `rel` is required;
//     `dir` defaults to "in" (incoming pairings — find things that
//     point AT the source via this relation); `kind` filters target
//     kinds when one source pairs with multiple kinds via the same
//     relation.
// See docs/architecture/wires-and-bundles.md (Q1, resolved).
export const WireTarget = z.union([
  z.literal("self"),
  // "none": the wire fires with NO entity context — for trigger events
  // that don't originate from an entity (e.g. an inbound webhook). The
  // action locates its own target from its (template-rendered) args;
  // templates see only the event.* block. See wires-and-bundles.md.
  z.literal("none"),
  z.object({
    rel: z.string().min(1),
    dir: z.enum(["in", "out"]).optional(),
    kind: z.string().optional(),
  }),
]);

export type WireTargetDecl = z.infer<typeof WireTarget>;

// Action predicate. Either {any: true} (universal) or a structured
// predicate combining kinds + traits + hasFieldRole. Across the three
// sub-predicates the semantics is OR (any one hitting matches); within
// `traits` the semantics is AND (all listed traits must be present).
//
// Examples:
//   { kinds: ["projects:task"] }
//     → only this exact kind
//   { traits: ["physical"] }
//     → any entity kind whose trait fingerprint includes "physical"
//   { traits: ["physical", "fungible"] }
//     → both required (Stock material profile only)
//   { traits: ["physical"], kinds: ["projects:task"] }
//     → any physical thing OR specifically this task kind
//   { hasFieldRole: "title" }
//     → any kind that declared a field with role=title
export const ActionAppliesTo = z.union([
  z.object({ any: z.literal(true) }),
  z
    .object({
      kinds: z.array(z.string()).min(1).optional(),
      traits: z.array(z.string()).min(1).optional(),
      // A native field role ("quantity") OR a workspace field role ("expiry",
      // "assignee"). The second half is what lets an action follow the
      // WORKSPACE's own vocabulary: a bundle marks its "Best before" field as
      // expiry, and every action about perishables appears on that table and
      // on no other. Before this, the only way to scope "Threw it out" was to
      // the whole inventory kind, so a box of screws offered it too.
      hasFieldRole: z.union([EntityFieldRole, FieldRoleSchema]).optional(),
      // What the record must ALSO be, whichever of the above matched. The
      // three above are OR; this is AND. A status, a home or a stock count
      // belongs to a physical thing, so an action scoped to a module's kind
      // says `requires: { traits: ["physical"] }` and is not offered on a
      // collection of that kind that holds descriptions of things (a filament
      // TYPE, whose collection resolves no traits).
      requires: z.object({ traits: z.array(z.string()).min(1) }).optional(),
    })
    .refine(
      (d) => d.kinds || d.traits || d.hasFieldRole,
      "appliesTo: must specify at least one of kinds, traits, or hasFieldRole (or use { any: true } for universal match)",
    ),
]);

export const ActionIdRegex = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

// A permission a module checks at one of its own routes that is not an action
// anyone runs: "delete a place with places inside it" is the Delete button
// on a bigger target, not a verb of its own. Declared here, it appears in the
// permissions matrix beside the actions, an admin can grant it, and a member
// refused it gets the ask (approvals.ts), because a capability nobody can
// grant is a door only the admin tier can ever pass.
export const ModuleCapability = z.object({
  id: z.string().regex(ActionIdRegex, "capability id must be <module>:<name>"),
  label: z.string().min(1),
  // What holding it lets a person do, shown in the permissions matrix under
  // the label, where an admin decides whether to grant it.
  description: z.string().min(1),
  // The stock roles that hold it without a grant, the way a member holds
  // taking stock: `operator` is a member who runs the machines, and holds
  // what a module says an operator does (#6672). The admin tier holds every
  // capability anyway; a guest never holds one by role.
  heldBy: z.array(z.enum(ORG_ROLES).refine((r) => r !== "guest" && !roleHoldsEveryCapability(r), "Only a role below the admin tier, and never a guest, holds a capability by role.")).optional(),
});
export type ModuleCapability = z.infer<typeof ModuleCapability>;


// A COMMAND a module ships: a sentence its users would type, and what to do
// when they type it.
//
// The no-AI floor answers with text, so a workspace without a model can be told
// how to add a location and never asked to add twelve. A workspace can teach
// itself commands by watching an AI work (docs/…/learned commands), but that
// only helps somebody who already had an AI. Shipping the common ones means a
// brand-new workspace, with no AI at all, can already be asked for the handful
// of things everyone wants.
//
// The author writes the SENTENCE, never a regex: `template` is compiled into
// its pattern and slots. A hand-written expression is a way to get subtly wrong
// something that writes to workspaces.
export const ModuleCommand = z.object({
  // Stable id, <module>:<name>, so a workspace can turn one off by name.
  id: z.string().regex(ActionIdRegex, "command id must be <module>:<name>"),
  // What a user would type, with {blanks}: "make rack {from} through {to} in
  // {parent}". `from`/`to` are the range pair by convention and the only slots
  // that match digits.
  template: z.string().min(3).max(300),
  // One line for the settings list: what it does, in words. It may carry the
  // template's {blanks}: "Add {choice} to the {field} choices" reads as a
  // description in the list and, filled with what the person typed, is the
  // offer's own summary ("Add Aran to the yarn weight choices") instead of
  // the generic "Runs edit field".
  description: z.string().max(300).optional(),
  // What to do, with {slot} references. Same shape a learned command stores, so
  // shipped and learned commands run through exactly one code path.
  plan: z
    .array(
      z.object({
        tool: z.enum(["create", "update", "delete", "action"]),
        entityKind: z.string().default(""),
        actionId: z.string().optional(),
        payload: z.record(z.unknown()),
      }),
    )
    .min(1)
    .max(5),
  // For a command that repeats over a range: which payload field counts, and
  // the shape around the counter ("Rack {n}").
  repeatField: z.string().optional(),
  repeatShape: z.string().optional(),
});
export type ModuleCommandDecl = z.infer<typeof ModuleCommand>;

/** One blank in a command template. */
export interface CommandSlot {
  name: string;
  kind: "text" | "number" | "range";
}

function escapeCommandRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a written template into the pattern and slots that bind it.
 *
 *   "make rack {from} through {to} in {parent}"
 *     → ^\s*make rack (\d+) through (\d+) in (.+?)\s*$
 *     → from:number, to:number, parent:text
 *
 * This is what lets a MODULE ship a command: an author writes the sentence
 * their users would type and never writes a regex. Nobody should have to
 * hand-author an anchored expression with the capture groups in slot order to
 * contribute one, and a hand-written one is a way to get it subtly wrong in a
 * thing that writes to workspaces.
 *
 * `from` and `to` are the range pair by convention, and are the only slots
 * matched as digits — everything else is text.
 */
export function compileTemplate(template: string): { pattern: string; slots: CommandSlot[] } | null {
  const text = template.trim();
  if (!text) return null;
  const slots: CommandSlot[] = [];
  let pattern = "";
  let last = 0;
  for (const m of text.matchAll(/\{([a-z0-9_]+)\}/gi)) {
    const name = m[1]!;
    if (slots.some((s) => s.name === name)) return null; // one capture per slot
    pattern += escapeCommandRegex(text.slice(last, m.index!));
    const numeric = name === "from" || name === "to";
    pattern += numeric ? "(\\d+)" : "(.+?)";
    slots.push({ name, kind: numeric ? "number" : "text" });
    last = m.index! + m[0]!.length;
  }
  if (slots.length === 0) return null; // a command with no blanks is a macro
  pattern += escapeCommandRegex(text.slice(last));
  return { pattern: `^\\s*${pattern}\\s*$`, slots };
}



/** A KIND of workspace notification a module sends: the eventType it
 *  dispatches with, and the name a person would recognise it by on the
 *  "who gets told" settings page. */
export const NotificationKind = z.object({
  eventType: z.string().regex(/^[a-z0-9-]+\.[a-z0-9._-]+$/, "eventType is <module>.<what>"),
  label: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
});
export type NotificationKind = z.infer<typeof NotificationKind>;

export const MODULE_PART_ID = /^[a-z][a-z0-9-]*$/;

export const EntityAction = z.object({
  /** The module part this action belongs to (manifest `parts`). Off in a
   *  workspace, the action is hidden and refused there like a module's. */
  part: z.string().regex(MODULE_PART_ID).optional(),
  group: ActionGroupReference.optional(),
  primary: z.boolean().default(false),
  id: z
    .string()
    .regex(ActionIdRegex, "action id must be <module>:<name>"),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  appliesTo: ActionAppliesTo.default({ any: true }),
  // Entity vs workspace scope. Default "entity": the action runs ON a record
  // — the entity-detail button, a wire target, invoke_action with an entity.
  // "workspace": a config/admin operation that runs on the WORKSPACE itself,
  // not any one record (rename a label-code prefix, flip a default, seed a
  // group). A workspace action skips entity resolution (its handler's ctx has
  // no `entity`), never renders as an entity-detail button, and `appliesTo` is
  // ignored (it matches no kind). Crucially it is reached through the SAME
  // invoke_action rail with no entity_kind/entity_id — which is how a config
  // operation becomes AI-reachable (Cobb / MCP) WITHOUT a bespoke per-op tool.
  // See docs/architecture/wires-and-bundles.md and the AI-reachability lint.
  scope: z.enum(["entity", "workspace"]).default("entity"),
  /** What running it changes: `records` (adds, edits, moves or reads the
   *  workspace's things) or `workspace` (its settings and defaults, its
   *  fields and navigation, its connections, devices and stations, its
   *  public links). A token that may change only records is refused a
   *  `workspace` action at the invoke route, the twin of a platform action's
   *  `changes: "setup"` (#7356). Required, so no action is left undecided;
   *  an action that does what one of its module's routes does says what
   *  module-write-changes.ts says of that route. Not `scope`: a workspace-
   *  scoped action adds records all the time. */
  changes: z.enum(["records", "workspace"]),
  // Whether this action renders as a clickable button on entity-
  // detail pages. Default true. Set false for wire-only actions
  // (event reactions) — they're still targetable by wires, just
  // not surfaced as a manual button.
  userInvokable: z.boolean().default(true),
  // Exists only as the way back for another action: registered as an undo
  // step, run by Undo on a card through the actions route, and otherwise
  // unreachable. Not a button (userInvokable is false too), and not in any
  // list the assistant reads: the registry hides it from every reader that
  // does not ask for it, and the chat refuses a model that names one. A
  // guard holds that every action reached only as an undo step says this.
  internal: z.boolean().default(false),
  // Fired by an EVENT and nothing else: its record is named by the event's
  // payload (a task by linkedTaskId, an inbox row by the scan), so asked in
  // words there is nothing to act on. Not offered to the assistant, on the
  // rail or in list_actions. This is NOT `userInvokable: false`, which only
  // says "no button on the record's page" and is set on plenty of actions
  // the assistant runs every day (placing a thing in a bin, tagging it,
  // adjusting stock); reading that flag as wire-only took twelve of those
  // off the rail (2026-09-14). An action that says this has no phrasings
  // (a guard holds it), and an event-subject action with none says this.
  wireOnly: z.boolean().default(false),
  // An entity-scoped action that may ALSO run with no record: its handler
  // reads `ctx.entity` when there is one and its arguments when there is
  // not. lists:add-item is the case: a low-stock wire adds THIS part to the
  // shopping list, and a person says "put milk on the shopping list" where
  // milk is not a record at all. Without this the invoke door required a
  // record for every entity action, so the action's own example sentence
  // could not run, and a stranger asking it got an empty list created and
  // no milk (2026-09-22, #3255). Not `scope: "workspace"`, which would strip
  // the record from the wire that has one.
  recordOptional: z.boolean().default(false),
  // Can running this by mistake be put right again, INSIDE the workspace?
  //
  // This is what decides whether an AI connection that cannot show a
  // confirmation prompt may run it. The rule was "records yes, actions never",
  // which is not the real line: a relayed chat auto-applies create / update /
  // DELETE on records because those are tracked and undoable, and it blocked
  // reordering locations, which is undone by reordering them again. Cobb was
  // left saying he had no tool for it at all (2026-08-19).
  //
  // Default FALSE, because the unsafe answers are the interesting ones: an
  // action can command a device, send a message, place an order or destroy a
  // set of rows, and none of those come back. Say `undoable: true` only when
  // every effect stays in this workspace AND a person can put it back without
  // help. When in doubt, leave it: the cost is a refusal that explains itself,
  // not a silently missing capability.
  undoable: z.boolean().default(false),
  /** Who may run it without being granted it: the lowest role, by rank
   *  (@cobblr/platform-contract/org-roles). A guest never is. Absent: the
   *  admin tier, and anyone granted it (#5170).
   *
   *  The ONE answer for every door. A route that does the same thing gates
   *  with requireCapability on this action's id, which reads this, so a
   *  member who may add a line on the Purchases page may add it through the
   *  API and through Cobb too, and one who may not is refused at all three.
   *  lint:route-and-action-gate-agree holds every paired route to it.
   *
   *  `"requester"`: the person who started what it answers (their service
   *  job, the change the assistant held for them) runs it whatever their
   *  role, and the admin tier as ever; the module registers who that is with
   *  platform().actions.registerRequester (#5192). Every invokable action
   *  says one of these or `grantedAs` (lint:every-action-says-who-runs-it). */
  runBy: z.union([z.enum(ORG_ROLES).refine((r) => r !== "guest", "A guest never runs an action by role."), z.literal("requester")]).optional(),
  /** A capability whose grant also covers this action, when several actions
   *  share one permission (inventory's holdings are all "add a part"). */
  grantedAs: z.string().regex(ActionIdRegex).optional(),
  /** What running it does to the world, which decides who has to say yes
   *  (services.md §9): `none`, `writes`, `physical` (moves or heats
   *  something: sending a print) or `spends`. The same field a service
   *  capability declares. Absent reads as `writes`. `physical` is never run
   *  without a person's confirm, from any door. */
  effect: z.enum(SERVICE_EFFECTS).optional(),
  /** What this action does to a dated thing that is due, when it is one of
   *  the verbs that settle it: `used` (it is gone, used), `discarded` (it went
   *  off and was thrown out), `still-good` (checked, fine, due again later).
   *  A surface that lists what is due ("needs you") offers the applicable
   *  actions that declare one, so no screen names a module's action ids and a
   *  new module's verbs appear by declaring this. Absent = not such a verb. */
  finishes: z.enum(["used", "discarded", "still-good"]).optional(),
  /** This action IS one of a station's own stock moves (`use` = "Used one",
   *  `add` = "+1", `total` = "Set total"), done through the record's own
   *  door. A surface that already shows that move (a station's countable
   *  card) does not offer it again beside its own button (#5710). */
  stockMove: z.enum(["use", "add", "total"]).optional(),
  /** It edits a record's fields from what a person types (update the item,
   *  set its status): a form, never a one-tap press. A kiosk offers none. */
  editor: z.boolean().optional(),
  /** Which face this verb belongs to, for DISCLOSURE: a hidden face takes its
   *  verbs off the record along with its fields and panels. Eligibility is
   *  `appliesTo` (facts); this is the person's choice. Absent = the base
   *  record, shown whatever is hidden. */
  face: FaceSchema.optional(),
  // How a PERSON asks for this, in their own words. One or two lines.
  //
  // The action list in the assistant's prompt is ids and labels, which tells a
  // model what exists and not what a request for it sounds like. An example is
  // the cheapest possible bridge between "someone typed a sentence" and "this
  // is the action that answers it", and it doubles as the phrasing a command
  // can be written from. Kept short: these ride in every chat prompt.
  examples: z.array(z.string().min(3).max(120)).max(3).default([]),
  // UI route the platform navigates to when the user clicks the
  // action. {entityKind}, {entityId} placeholders.
  invokeRoute: z.string().optional(),
  // Handler key the module registered via
  // platform.actions.registerHandler() at boot. Optional — actions
  // can be route-only.
  invokeHandler: z.string().optional(),
  // Optional machine-readable arg shape. Keys are the arg names the
  // invokeHandler reads from ctx.args; each has a label + a type. The wire
  // composer renders a labelled field per arg (each value a literal or a
  // {{token}}); the wire engine renders string args at fire time. Absent →
  // the composer falls back to a free template.
  //
  // "list" is a sequence, not a scalar. It exists because core-locations:reorder
  // takes `ids` and could only declare itself "text", so every caller that read
  // the schema was told to send a string to a handler that required an array —
  // and an assistant reading that concluded it could not run the action at all
  // (2026-08-19). A "list" arg must be accepted by its handler BOTH as a real
  // array and as a delimited string, since the wire composer's field is a text
  // box and always will be. "json" is the same bargain for a structured value
  // (an order's line items, a view's config): read it with readJsonArg.
  // `required`: the handler cannot do without it. The invoke door, the
  // assistant's guard and the bench all read this one flag, so a call that
  // drops it is refused before it becomes a card that dies on press; without
  // it every caller assumed and nothing noticed (#3123). An argument the
  // handler defaults or tolerates absent is left unmarked.
  argsSchema: z
    .record(
      z.object({
        label: z.string().min(1),
        // `date` is a calendar day (YYYY-MM-DD), asked with a date picker.
        type: z.enum(["text", "number", "boolean", "list", "json", "date"]).default("text"),
        required: z.boolean().optional(),
        // Required as a group ("fields or rename_to"): at least one of the
        // arguments naming the same group must be carried.
        oneOf: z.string().min(1).optional(),
        // What may be picked, in a person's words; the form offers a choice
        // instead of a text box. `choicesFrom` is the same for choices that
        // depend on the record's kind (its counters), resolved by the server
        // when it lists the kind's actions.
        choices: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).optional(),
        choicesFrom: z.enum(["counters", "people", "recipients"]).optional(),
        // Offered on the button's sheet though the action runs without it.
        ask: z.boolean().optional(),
        // Asked and required together with that argument (every_n with
        // every_unit): the form waits for both and the door refuses one alone.
        with: z.string().min(1).optional(),
        // An amount of money, given the way a person says it ("45", "$45.50"):
        // asked with the money input, shown on a confirm card as "$45.50", and
        // turned into its column's shape by the handler
        // (@cobblr/platform-contract/money moneyForStorage). Never cents.
        money: z.boolean().optional(),
        // Where something happens: an address object
        // (@cobblr/platform-contract/address) or the address as said. Shown on
        // a confirm card as one line ("MVC Lodi Agency, 8 Mill St, Lodi"),
        // read by the handler through asAddress.
        address: z.boolean().optional(),
      }),
    )
    .optional(),
  // The event payload keys this action reads when a wire fires it and the
  // wire's own args do not say (adjust-stock takes partId and delta off the
  // event). Every shipped wire into this action must then carry each key in
  // its args or trigger on an event whose declared payload has it:
  // "Mark arrived" once emitted `qty` where the stock wire read `delta`, the
  // wire skipped in silence, and nothing added the stock
  // (scripts/every-wire-gets-what-its-action-reads.test.ts).
  readsFromEvent: z.array(z.string().min(1)).optional(),
  version: z.string().optional(),
});

// A LIVE CONTROL — the Live box (docs/design-decisions/live-controls.md). An
// ongoing session mode a module exposes: scan-drive, auto-print, a drive
// indicator. The platform aggregates these across enabled modules; the box
// renders only the ones whose `requires` capability the workspace currently
// satisfies (none apply → the box renders nothing, like DriveBanner when idle).
// The declaration is metadata + gating + shape; reading/writing the toggle wires
// per `scope` (see the doc §6).
const LiveControlIdRegex = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/;
export const LiveControl = z
  .object({
    // Stable id, <module>.<name>, e.g. "labels.auto-print".
    id: z.string().regex(LiveControlIdRegex, "live control id must be <module>.<name>"),
    label: z.string().min(1),
    // Kebab-case lucide icon name.
    icon: z.string().min(1),
    // The capability signal that must be present for this control to appear
    // (e.g. "printer.connected", "scanner.bridge") — a capability a module
    // provides. The box hides the control unless the workspace satisfies it;
    // this is what keeps the box self-hiding without any module knowing it exists.
    requires: z.string().min(1),
    // Where the on/off lives, so a flip writes to the right place:
    //   tab       — this browser tab only (localStorage; scan-drive follower)
    //   user      — the signed-in user everywhere (server; auto-print policy)
    //   workspace — the whole org (server)
    scope: z.enum(["tab", "user", "workspace"]).default("user"),
    // The shape the renderer draws:
    //   switch         — a bare toggle
    //   switch-segment — a toggle + an inline segmented choice (needs `segment`)
    //   switch-detail  — a toggle + an expandable body + a "configure" deep-link
    //   status         — a status row + stop/dismiss, no on-toggle (the drive
    //                    indicator fold-in)
    control: z.enum(["switch", "switch-segment", "switch-detail", "status"]).default("switch"),
    // For control "switch-segment" — the inline choices (Open/Print for scan-drive).
    segment: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).optional(),
    // For scope user/workspace — the org-scoped path the box GETs for current
    // state and PUTs to flip. Omitted for scope tab (the renderer uses a
    // client-side adapter keyed by `id`; doc §6).
    endpoint: z.string().optional(),
    // Deep-link the expanded "configure" opens (control "switch-detail").
    detail: z.string().optional(),
    // Sort order within the box (ascending); absent sorts after ordered ones.
    order: z.number().optional(),
    version: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.control === "switch-segment" && (!c.segment || c.segment.length < 2)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "control 'switch-segment' needs a `segment` of at least 2 choices" });
    }
    if ((c.scope === "user" || c.scope === "workspace") && c.control !== "status" && !c.endpoint) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `scope '${c.scope}' control needs an \`endpoint\` (server-side state)` });
    }
  });

/** The Configuration pages a module may add a section to
 *  (`contributes.panels`, surface "configuration-section"), by their path under
 *  /configuration. A kernel settings page that shows one module's setting
 *  hosts it this way rather than importing the module's code
 *  (lint:kernel-config-pages-name-no-module). */
export const CONFIGURATION_SECTION_HOSTS = ["notification-audiences"] as const;
export type ConfigurationSectionHost = (typeof CONFIGURATION_SECTION_HOSTS)[number];
