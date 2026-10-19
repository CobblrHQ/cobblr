import type { ActionAppliesToDecl } from "@cobblr/platform-contract/module-manifest";
import type { ActionUndoContext, ActionUndoer, ActionUndoStep } from "@cobblr/platform-contract/action-undo";
import type { CollectionTraits } from "@cobblr/platform-contract/entity-fields";
import type { FaceName } from "@cobblr/platform-contract/field-vocabulary";

// ──────────────── Pillar B runtime — actions ───────────────────────

/** Programmatic action handler. The platform routes
 *  platform.actions.invoke() calls to the right module's handler.
 *  Returns whatever the module wants — the caller might be the
 *  wire-engine running an event-triggered action, in which case
 *  the return is mostly ignored. */
export type ActionHandler = (ctx: ActionInvokeContext) => Promise<unknown>;

/** What an action is about to do, from its arguments, before it does it. One
 *  line for a single record; for a bulk action a list: every record that
 *  moves, and where. */
export interface ActionPlan {
  /** One line, the change in a sentence: "Move 5 records from Pantry into Tea". */
  title: string;
  /** One line per thing touched, by what a person calls it. */
  lines: string[];
}
/** A planner answers the plan, or the reason there is none. A reason goes
 *  back to the caller (the assistant fixes its arguments); a plan goes on
 *  the confirm card. Nothing else is ever shown. */
export type ActionPlanner = (ctx: ActionInvokeContext) => Promise<ActionPlan | { error: string } | null>;

/** A UI directive an action handler MAY include in its result to ask the web
 *  shell to open a first-party FLOW after the action completes — e.g.
 *  disassemble-kit returning `{ ok, ui: { flow: "core-scan:organize", args:
 *  { scope: "refs", refs } } }` so the sorting planner opens over exactly the
 *  parts it just spawned. The shell's action-invoke path (EntityActionsBar)
 *  reads `result.ui` and opens the registered flow; unknown flows are ignored,
 *  so this is safe to return whether or not the shell yet honors it. Declarative
 *  from the module's side — the handler returns data, never touches the web app
 *  (module isolation). Generic: any action of any module can hand off to any
 *  registered flow. See docs/architecture/invokable-flows-and-lego-redesign.md. */
export interface ActionUiDirective {
  /** Registered flow id, e.g. "core-scan:organize". */
  flow: string;
  /** Opaque args passed to the flow (e.g. { scope: "refs", refs: [...] }). */
  args?: Record<string, unknown>;
}

/** Per-request authentication context. Inherited from the originating
 *  request so wires fired async still carry the right actor (a stock
 *  bump from the UI fires wires tagged session; one from a `cbt_*`
 *  token fires wires tagged api_token with the token name). */
export interface ActionInvokeActor {
  user_id: string | null;
  display_name: string | null;
  auth_method: "session" | "api_token" | "system";
  /** Set only when `auth_method === "api_token"`; the token row id. */
  api_token_id?: string | null;
  /** Set only when `auth_method === "api_token"`; the token's name. */
  api_token_name?: string | null;
}

/** Q2 resolution: namespaced action context. Handlers receive the
 *  target entity, the originating event (or click context), and any
 *  pre-rendered template — each in its own block. ONE spelling for the
 *  record: `ctx.entity`. The top-level `entityKind` / `entityId` aliases
 *  are gone (2026-09-22) — a second spelling is a second thing every
 *  reader has to know about, and the one check that asks "does this
 *  handler read its record?" knew only the first, so it accused a handler
 *  that read the record through the alias (#3378).
 *  See docs/architecture/wires-and-bundles.md (Q2). */
/** One earlier step of a plan, as a later step's planner reads it. */
export interface PlanStepBefore {
  op: "delete";
  kind: string;
  id: string;
}

/** Who started what a run answers, from the arguments the run was given. */
export type ActionRequester = (ctx: { orgId: string; args: Record<string, unknown>; entity?: { kind: string; id: string } }) => Promise<string | null>;

export interface ActionInvokeContext {
  orgId: string;
  userId: string | null;
  /** An original uploaded with this authenticated request. Never an action
   *  argument, event payload or assistant message, and never ledgered. */
  document?: { bytes: Uint8Array; name: string; mimeType: string };
  /** Which pole this invocation runs on. "entity" (default) → `entity` is
   *  populated. "workspace" → a config/admin action with NO record, so
   *  `entity`/`entityKind`/`entityId` are all absent. A handler that reads
   *  `entity` must guard it: an entity-scoped handler can assert presence
   *  (the invoke route always populates it), a workspace handler never
   *  touches it. */
  scope?: "entity" | "workspace";
  /** The entity the action runs on. Present iff scope === "entity". For a
   *  wire with target='self', this is the source entity; for target:{rel,...}
   *  it's one of the entities discovered by walking pairings. The wire engine
   *  resolves it and projects through the kind's exposableFields. Absent for
   *  workspace-scoped actions. */
  entity?: {
    kind: string;
    id: string;
    fields?: Record<string, unknown>;
  };
  /** The originating event / user click / schedule that triggered
   *  this invocation. Always present; the `name`/`payload` shape
   *  varies by trigger type. */
  event: {
    name: string | null; // null for user-invoked
    payload: Record<string, unknown>;
    actor: ActionInvokeActor;
    timestamp: string; // ISO-8601
    trigger_type: "event" | "user-invoked" | "schedule" | "on-create" | "on-update" | "on-delete";
  };
  /** The wire that ran this, when a wire did (#6070): what an action that
   *  reaches outside the workspace names, limits and lets a recipient stop. */
  wire?: { id: string };
  /** Pre-rendered template result, if the binding had a template. */
  rendered?: string;
  /** Extra args from the binding (passed through). */
  args?: Record<string, unknown>;
  /** For a PLANNER only: what the earlier steps of the same plan will have
   *  done by the time this one runs, so what the card says counts after them
   *  ("Delete this yarn, then remove Yarn" never says Yarn keeps its one
   *  record). Absent for a run, which reads the workspace as it then is. */
  before?: PlanStepBefore[];
  /** The origin (`https://host`) of the request that invoked the action,
   *  when a person pressed a button: the same origin the module's own
   *  routes see, so a handler that must mint an absolute URL (a label's
   *  QR) can use it the way the manual path does. Absent for a wire, a
   *  schedule or a webhook run, which have no request; those fall back
   *  to the workspace's configured base and may refuse without one. */
  origin?: string;
}

/** Assert that an action ran on a record (scope 'entity') and return that
 *  entity, narrowed to non-null. Entity-scoped handlers call this at the top
 *  instead of reaching into `ctx.entity` directly: the invoke route always
 *  populates `entity` for an
 *  entity-scoped action, so this only throws if a workspace-scoped invocation
 *  somehow reached an entity handler (a wiring mistake) — a clear error beats
 *  a downstream `undefined.id`. Workspace handlers never call it; they read
 *  `ctx.args`. */
export function requireActionEntity(ctx: ActionInvokeContext): {
  kind: string;
  id: string;
  fields?: Record<string, unknown>;
} {
  if (!ctx.entity) {
    throw new Error(
      "This action runs on a record, but was invoked without one (workspace scope). " +
        "Check the action's `scope` and how it was triggered.",
    );
  }
  return ctx.entity;
}

/** Read a `list`-typed action argument as an array of non-empty strings,
 *  whatever shape the caller sent.
 *
 *  A handler must not care: the SAME argument arrives as a real JSON array from
 *  invoke_action, and as a plain string from the wire composer, whose arg field
 *  is a single text box and always will be. When core-locations:reorder read
 *  `ctx.args.ids` with a bare `Array.isArray`, a caller who sent
 *  "id-a, id-b" got an empty list and an unhelpful refusal — with no way to
 *  tell from the schema which of the two forms was wanted (2026-08-19).
 *
 *  Accepts: an array (of strings, or of anything stringifiable), a JSON array
 *  in a string, or a string delimited by commas / newlines / whitespace.
 *  Returns [] when the arg is absent or empty — the caller decides whether
 *  empty is an error. */
export function readListArg(
  args: Record<string, unknown> | undefined,
  name: string,
): string[] {
  const raw = args?.[name];
  if (raw == null) return [];
  const clean = (xs: unknown[]): string[] =>
    xs.map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim())).filter(Boolean);
  if (Array.isArray(raw)) return clean(raw);
  if (typeof raw !== "string") return clean([raw]);
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return clean(parsed);
    } catch {
      // Not JSON after all; fall through to delimiter splitting.
    }
  }
  return clean(text.split(/[\s,]+/));
}

/** Read a `json`-typed action argument as a structured value, whatever shape
 *  the caller sent.
 *
 *  The twin of readListArg, for the same reason: invoke_action can send a real
 *  object or array, and a wire's arg field can only ever send the text a person
 *  typed into it. A handler that tests `typeof args.config === "object"` throws
 *  away the second form silently.
 *
 *  Returns undefined when the arg is absent, blank, or is a string that is not
 *  valid JSON - the caller decides whether that is an error. */
export function readJsonArg<T = unknown>(
  args: Record<string, unknown> | undefined,
  name: string,
): T | undefined {
  const raw = args?.[name];
  if (raw == null) return undefined;
  if (typeof raw !== "string") return raw as T;
  const text = raw.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export interface PlatformActions {
  registerHandler(handlerKey: string, handler: ActionHandler): void;
  /** What the action behind `handlerKey` would touch, from its arguments, or
   *  the reason there is no plan: asked before a confirm card exists, so
   *  "no unit called that" reaches the caller instead of a card that dies on
   *  press. A module registers it beside its handler. */
  registerPlanner(handlerKey: string, planner: ActionPlanner): void;
  /** Whether a wire may be saved with this action (by id) and these
   *  arguments: the reason it may not, or null. Asked when a wire is
   *  created or changed, so a wire that could never do its job is refused
   *  with the reason instead of failing at every firing (#6070). */
  registerWireCheck(actionId: string, check: (ctx: { orgId: string; args: Record<string, unknown> }) => Promise<string | null>): void;
  /** How the action behind `handlerKey` is undone, from its result. Register
   *  it beside the handler; an action declared `undoable` must have one (a
   *  guard test holds the two together), and the card after a run offers
   *  Undo exactly when the run handed steps back. See action-undo.ts. */
  registerUndo(handlerKey: string, undoer: ActionUndoer): void;
  /** Who started the thing this run answers: the person whose service job,
   *  held change or request it is, from its arguments, or null when nobody
   *  did. An action declared run by "requester" registers one beside its
   *  handler, and the action door lets that person through whatever their
   *  role (#5192): a person may always answer, undo or cancel what they
   *  themselves started. The handler still checks it too. */
  registerRequester(handlerKey: string, requester: ActionRequester): void;
  /** Find every registered action that applies to a given entity
   *  kind, factoring in `applies_to` predicates. When `orgId` is
   *  provided, per-org appliesTo overrides take precedence over the
   *  module-declared default, and only modules the workspace has turned on
   *  count; `alsoOn` names modules the caller is about to turn on (a bundle
   *  install that enables what it requires), so their actions count too. */
  listApplicable(kind: string, orgId?: string, opts?: { alsoOn?: readonly string[] }): Promise<EntityActionRecord[]>;
  /** Invoke an action programmatically. Throws if no handler is
   *  registered for the action's invoke_handler key. */
  invoke(actionId: string, ctx: ActionInvokeContext): Promise<unknown>;
  /** The way back from a run, from its result: the steps the action's own
   *  undoer hands back (see registerUndo), or null when it left nothing to put
   *  back or has no undoer. A module that invokes another module's action and
   *  wants to keep its inverse beside its own record (a scan attach keeping
   *  the restock's) asks here, the same way the invoke route does. */
  undoFor(actionId: string, result: unknown, ctx: ActionUndoContext): Promise<ActionUndoStep[] | null>;
  /** What the actions' arguments pick from, for one kind: returns a function
   *  that gives an `args_schema` with every `choicesFrom` argument filled in
   *  as `choices` (the usage counters, the workspace's People). The same fill
   *  GET /actions?kind= answers with, for a module's own door that shows an
   *  action's form (a Station's Lend offers names, never an id box). */
  argChoices(orgId: string, kind: string, schemas: readonly unknown[]): Promise<(schema: unknown) => unknown>;
}

/** What a collection wears, as the platform resolved it: the trait values
 *  (real and trial axes) and the faces they imply. */
export interface FaceVerdict {
  kind: string;
  /** Eligibility: the trait values the collection wears (facts). */
  traits: CollectionTraits;
  /** Disclosure: the faces a person sees (facts less their choices). */
  faces: FaceName[];
  /** Which faces were chosen in config rather than derived. */
  explicit: FaceName[];
  /** The faces a person may turn on from a record ("More about this item").
   *  Every face not worn, except where the collection's shape rules them
   *  out: a family's type collection offers none (its things carry them). */
  offers: FaceName[];
}

export interface EntityActionRecord {
  group?: string | null;
  primary?: boolean;
  id: string;
  module_name: string;
  label: string;
  /** Can a mistaken run be put back (the manifest's `undoable`)? A surface
   *  that runs it one tap from a scan or a list row reads this: an action
   *  label only offers what its Undo can take back (#3897). */
  /** The station stock move this action is, if any (manifest `stockMove`). */
  stock_move?: "use" | "add" | "total" | null;
  /** It edits the record's fields from typed values (manifest `editor`). */
  editor?: boolean;
  undoable?: boolean;
  description: string | null;
  icon: string | null;
  applies_to: ActionAppliesToDecl;
  /** "entity" (default) → runs on a record; "workspace" → a config/admin
   *  operation with no record (skips entity resolution, never an entity
   *  button, matches no kind). */
  scope: "entity" | "workspace";
  invoke_route: string | null;
  invoke_handler: string | null;
  /** False = wire-only; don't render as a user button. */
  user_invokable: boolean;
  /** The way back for another action, and nothing else: run from Undo only. */
  internal: boolean;
  /** Fired by an event and nothing else; its record comes from the event.
   *  Never offered to the assistant. Distinct from user_invokable, the
   *  button flag. */
  wire_only: boolean;
  /** Runs on a record when given one, and with no record too (the manifest's
   *  `recordOptional`). */
  record_optional?: boolean;
  /** What it does to a due, dated thing (the manifest's `finishes`), or null. */
  finishes?: "used" | "discarded" | "still-good" | null;
  /** Disclosure: the face this verb belongs to, or null for the base. */
  face: string | null;
  /** Where the module declared it, 0-based. The strip lists a record's own
   *  module's actions first, in this order. */
  position: number;
  /** Machine-readable arg shape for the wire composer / invoke forms; null if
   *  the action declared none. */
  args_schema: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json" | "date"; required?: boolean; oneOf?: string; choices?: { value: string; label: string }[]; choicesFrom?: "counters" | "people" | "recipients"; ask?: boolean; with?: string }> | null;
  version: string;
}
