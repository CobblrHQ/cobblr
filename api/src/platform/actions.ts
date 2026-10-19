// Capability Registry runtime. Mirrors entities.ts but for actions
// rather than entities.

import { OFF_WHILE_LENT, lentWhy, loanOfFields } from "@cobblr/platform-contract/loan";
import { isActionStep, onTheSameRecord, type ActionUndoStep, type ActionUndoer, type ActionUndoContext } from "@cobblr/platform-contract/action-undo";
import type {
  ActionPlan,
  ActionPlanner,
  ActionAppliesToDecl,
  ActionHandler,
  ActionInvokeContext,
  EntityActionRecord,
} from "@cobblr/platform-contract";
import { axisOfTrait, PLATFORM_OWNER, type ActionRequester, type AnyAxisName } from "@cobblr/platform-contract";
import { requiredArgsRefusal, typedArgs } from "@cobblr/platform-contract/action-args";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { ActionRefusal } from "@cobblr/platform-contract/action-refusal";
import { meta } from "../db/meta.js";
import { actionPart, enabledOwnersWithParts, partOffRefusal, partOwner } from "./module-parts.js";
import { listEntries } from "../modules/registry.js";
import { facesForKind } from "./faces.js";
import { fieldRolesForKind } from "./field-defs.js";
import { canResolve, lookup, listKinds, getKind, listKindsForOrg, baseKindOf } from "./entities.js";

const handlers = new Map<string, ActionHandler>();

export function registerHandler(handlerKey: string, handler: ActionHandler): void {
  handlers.set(handlerKey, handler);
}

/** Is a handler registered under this key? Exists for the guard test that pins
 *  platform-actions.ts ↔ platform-action-handlers.ts 1:1 — an action declared
 *  without its handler would fail at invoke time, in front of a user. */
export function hasHandler(handlerKey: string): boolean {
  return handlers.has(handlerKey);
}

/** What an action WILL touch, said before it runs.
 *
 *  A confirm card has one job: let a person check the change before it
 *  happens. "Move records into another list" is the action's name, not the
 *  change, and a card that says only the name asks for trust instead of
 *  offering a check. The rule is that a card always says exactly what it is
 *  about to do, and for a bulk action that is a list: every record that
 *  moves, and where. The handler already knows how to work that out; a
 *  planner is the same reading with the write left off. */
/** The plan and planner shapes live in the contract now, so a module can
 *  register a planner beside its handler through platform().actions. A
 *  planner used to answer null for both "here is the plan" and "there is
 *  none", and null is what let a confirm card fall back to the action's bare
 *  label ("Move records into another list") when the model had passed a list
 *  that did not exist - the card the rule was written against. */
export type { ActionPlan, ActionPlanner };

const planners = new Map<string, ActionPlanner>();

/** Whether a wire may be saved with this action and these arguments, said
 *  before it is saved rather than at every firing (#6070: a wire that would
 *  message someone outside the workspace while the workspace cannot). A
 *  module registers it beside its handler, by action id. */
export type WireCheck = (ctx: { orgId: string; args: Record<string, unknown> }) => Promise<string | null>;
const wireChecks = new Map<string, WireCheck>();

export function registerWireCheck(actionId: string, check: WireCheck): void {
  wireChecks.set(actionId, check);
}

/** A wire's arguments as its action's schema types them, so what is saved is
 *  what the action reads: a boolean saved as a boolean (#6130). */
export async function typedWireArgs(actionId: string, args: Record<string, unknown> | null | undefined): Promise<Record<string, unknown> | null | undefined> {
  if (!args) return args;
  const row = await meta.selectFrom("entity_actions").select("args_schema").where("id", "=", actionId).executeTakeFirst();
  return typedArgs(row?.args_schema as ArgsSchema, args);
}

/** Why a wire running `actionId` with `args` cannot be saved, or null. */
export async function wireCheckRefusal(actionId: string, orgId: string, args: unknown): Promise<string | null> {
  const check = wireChecks.get(actionId);
  if (!check) return null;
  return check({ orgId, args: args && typeof args === "object" ? (args as Record<string, unknown>) : {} });
}

export function registerPlanner(handlerKey: string, planner: ActionPlanner): void {
  planners.set(handlerKey, planner);
}

/** Pinned by the guard test: every action that takes a LIST of records has a
 *  planner, so no bulk change can ship with a card that names only itself. */
export function hasPlanner(handlerKey: string): boolean {
  return planners.has(handlerKey);
}

/** The action that puts THIS one back. An action that can say how it is
 *  undone registers it beside its handler, in the same terms the rail already
 *  runs: an action id and its arguments. The inverse is ledgered as a write
 *  of its own when it runs, and its own inverse is the original again, so
 *  undoing an undo needs nothing extra. Every action either has one of these
 *  or is declared not undoable, and a guard test holds the two together. */
export type ActionUndo = ActionUndoStep;
/** One step or several, in order: fields that came out of two headings go
 *  back under both. An empty list, or null, means this run left nothing to put
 *  back (a feature that was already on, a toggle to what it already was).
 *  The shape lives in the contract so a module registers the same way. */
export type { ActionUndoer };

const undoers = new Map<string, ActionUndoer>();

export function registerUndo(handlerKey: string, undoer: ActionUndoer): void {
  undoers.set(handlerKey, undoer);
}

export function hasUndo(handlerKey: string): boolean {
  return undoers.has(handlerKey);
}

/** The registered undoer itself, for a test to hand a result to. */
export function undoerFor(handlerKey: string): ActionUndoer | undefined {
  return undoers.get(handlerKey);
}

const requesters = new Map<string, ActionRequester>();

export function registerRequester(handlerKey: string, requester: ActionRequester): void {
  requesters.set(handlerKey, requester);
}

/** Is `userId` the person who started what this run of `actionId` answers?
 *  False for an action with no requester, or a target nobody started. */
export async function isRequester(actionId: string, userId: string, ctx: Parameters<ActionRequester>[0]): Promise<boolean> {
  const row = await meta.selectFrom("entity_actions").select("invoke_handler").where("id", "=", actionId).executeTakeFirst();
  const requester = row?.invoke_handler ? requesters.get(row.invoke_handler) : undefined;
  if (!requester) return false;
  const who = await requester(ctx);
  return who !== null && who === userId;
}

export async function undoFor(actionId: string, result: unknown, ctx: ActionUndoContext): Promise<ActionUndo[] | null> {
  const row = await meta
    .selectFrom("entity_actions")
    .select("invoke_handler")
    .where("id", "=", actionId)
    .executeTakeFirst();
  const undoer = row?.invoke_handler ? undoers.get(row.invoke_handler) : undefined;
  if (!undoer) return null;
  const steps = await undoer(result, ctx);
  const list = steps === null ? [] : Array.isArray(steps) ? steps : [steps];
  if (!list.length) return null;
  // A step that names a record action but no record runs on the record this
  // action ran on: an undoer that forgot to say so would otherwise hand Undo a
  // step that refuses ("runs on a record, but was invoked without one").
  const bare = list.filter((st) => isActionStep(st) && !st.entity_id).map((st) => (st as { action_id: string }).action_id);
  const entityScoped = bare.length && ctx.entity
    ? new Set((await meta.selectFrom("entity_actions").select(["id", "scope"]).where("id", "in", bare).execute()).filter((r) => r.scope !== "workspace").map((r) => r.id))
    : new Set<string>();
  return onTheSameRecord(list, ctx.entity, entityScoped);
}


/** The owners whose actions a workspace can run: the modules it has turned
 *  on, and the kernel's own. A module's ROUTES already refuse a workspace that
 *  has not enabled it (mount.ts requireModuleEnabled: a clean 409 in place of a
 *  raw `relation "..." does not exist`); its ACTIONS had no such door. So a
 *  model was offered purchases:draft-po in a workspace without purchases, and
 *  the card crashed on confirm with "check the log for act-..." (#3255). One
 *  rule, read by the three doors into an action: the list the assistant reads,
 *  the record's own action bar, and invoke. */
export async function enabledActionOwners(orgId: string): Promise<Set<string>> {
  const rows = await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute();
  // And `<module>/<part>` for each part that is on (module-parts.ts).
  return enabledOwnersWithParts(orgId, new Set([PLATFORM_OWNER, ...rows.map((r) => r.module_name)]));
}

/** The owner an action answers to: its module, or its module's part. */
export function actionOwner(a: { id: string; module_name: string }): string {
  const p = actionPart(a.id);
  return p ? partOwner(p.module, p.part) : a.module_name;
}

/** Why an action is not available here, when its module or part is off. */
async function offRefusal(row: { id: string; label: string; module_name: string }, orgId: string): Promise<{ code: string; module: string; part?: string; error: string } | null> {
  if (row.module_name === PLATFORM_OWNER) return null;
  const on = await enabledActionOwners(orgId);
  if (!on.has(row.module_name)) return { code: "module_not_enabled", module: row.module_name, error: moduleOffRefusal(row.label, row.module_name) };
  const p = actionPart(row.id);
  if (p && !on.has(partOwner(p.module, p.part))) return { code: "part_not_enabled", module: p.module, part: p.part, error: partOffRefusal(row.label, p.module, p.part) };
  return null;
}

/** The door's sentence for an action whose module is off here, in words: the
 *  action's label and the module's name, never an id. */
export function moduleOffRefusal(actionLabel: string, moduleName: string): string {
  const shown = listEntries().find((e) => e.manifest.name === moduleName)?.manifest.displayName ?? moduleName;
  // Said to whoever pressed it, a member included, so it names who can act
  // rather than sending them to a screen they cannot open (#3610).
  return `${actionLabel} is part of ${shown}, which is not turned on in this workspace. A workspace owner or admin can turn it on in Configuration → Modules.`;
}

/** The record an entity-scoped call names, or why there is none. A null
 *  lookup used to become `fields: {}` and the handler ran on a hollow record
 *  (#3141): seven actions answered ok to an id that matched nothing. A kind
 *  nobody wrote a resolver for cannot be checked and is let through as
 *  before; a kind that can be looked up and is not there is refused. */
export async function missingRecordRefusal(ctx: ActionInvokeContext, scope: "entity" | "workspace"): Promise<string | null> {
  if (scope !== "entity" || !ctx.entity?.kind || !ctx.entity.id) return null;
  if (!(await canResolve(ctx.orgId, ctx.entity.kind))) return null;
  const found = await lookup(ctx.orgId, ctx.entity.kind, ctx.entity.id);
  if (found) return null;
  return `No ${ctx.entity.kind} with id ${ctx.entity.id} here. Read the record first and pass its real id.`;
}

/** A thing lent out cannot be moved or labelled until it is back
 *  (OFF_WHILE_LENT, record-loans.md): "Lent to Sam Lee." */
async function lentRefusal(actionId: string, ctx: ActionInvokeContext): Promise<string | null> {
  if (!OFF_WHILE_LENT.has(actionId) || !ctx.entity?.kind || !ctx.entity.id) return null;
  const loan = loanOfFields(ctx.entity.fields) ?? (await lookup(ctx.orgId, ctx.entity.kind, ctx.entity.id).then((e) => (e ? loanOfFields(e.fields) : null)).catch(() => null));
  return loan ? lentWhy(loan) : null;
}

export async function planFor(
  actionId: string,
  ctx: ActionInvokeContext,
): Promise<ActionPlan | { error: string } | null> {
  const row = await meta
    .selectFrom("entity_actions")
    .select(["invoke_handler", "args_schema", "scope", "module_name", "label"])
    .where("id", "=", actionId)
    .executeTakeFirst();
  // The module first (#3255), then the record, then the arguments: no plan
  // for an action whose module is off here or a record that is not there,
  // and the reason goes back to the caller before any card exists.
  const off = row ? await offRefusal({ ...row, id: actionId }, ctx.orgId) : null;
  if (off) return { error: off.error };
  const gone = row ? await missingRecordRefusal(ctx, row.scope === "workspace" ? "workspace" : "entity") : null;
  if (gone) return { error: gone };
  const lent = await lentRefusal(actionId, ctx);
  if (lent) return { error: lent };
  // A boolean argument is a boolean whichever door sent it (#6130).
  if (row) ctx = { ...ctx, args: typedArgs(row.args_schema as ArgsSchema, ctx.args) };
  const refused = row ? requiredArgsRefusal(actionId, row.args_schema as ArgsSchema, ctx.args) : null;
  if (refused) return { error: refused };
  const planner = row?.invoke_handler ? planners.get(row.invoke_handler) : undefined;
  return planner ? planner(ctx) : null;
}

type ArgsSchema = Record<string, { label?: string; type?: string; required?: boolean; oneOf?: string; with?: string }> | null | undefined;

/** Does this action belong in a RECORD's action bar?
 *
 *  Pulled out of listApplicable so the rule can be tested without a database.
 *  It is the only thing standing between a workspace operation and a button on
 *  every record in the app, and it had no test: four actions whose handlers
 *  never read the record were declared entity-scoped and rendered everywhere,
 *  including in a location header where they pushed the title onto a second
 *  line (2026-08-23). */
export function belongsOnEntity(
  action: { scope: "entity" | "workspace" },
  predicate: ActionAppliesToDecl,
  fields: { role?: string }[],
  matchKind: string,
  traits: Record<string, unknown> | null,
): boolean {
  // Workspace-scoped actions run on the workspace, not a record. Their
  // appliesTo also defaults to { any: true }, which would otherwise match
  // every kind here.
  if (action.scope === "workspace") return false;
  return matchAction(predicate, fields, matchKind, traits).via !== null;
}

export async function listApplicable(
  kind: string,
  orgId?: string,
  opts: { alsoOn?: readonly string[] } = {},
): Promise<EntityActionRecord[]> {
  // An INSTANCE kind ("supplies:item") is synthesized per-org and never lands
  // in entity_kinds, so getKind missed it and every caller got zero actions —
  // no error, just an empty Do… dropdown in the wire composer and an action-less
  // record view in a generated app. (invoke() never checked the kind, so the
  // actions worked over the API the whole time; only DISCOVERY was blind.)
  //
  // Resolved off the synthesized record rather than the module's base kind, so
  // the instance's own traits drive applicability — a lean catalog instance of a
  // fungible module carries catalog-record traits, and matching against the
  // base's would offer it stock actions it shouldn't have. Only pays the heavier
  // per-org list when the cheap registry read misses.
  let kindRecord = await getKind(kind);
  if (!kindRecord && orgId) {
    kindRecord = (await listKindsForOrg(orgId)).find((k) => k.id === kind) ?? null;
  }
  if (!kindRecord) return [];
  const allActions = await meta
    .selectFrom("entity_actions")
    .selectAll()
    .orderBy("id")
    .execute();
  // Per-org overrides on appliesTo. Pull all of them for this org in
  // one query; map to action_id so the per-action filter is cheap.
  const overrideRows = orgId
    ? await meta
        .selectFrom("entity_action_org_overrides")
        .select(["action_id", "applies_to_override"])
        .where("org_id", "=", orgId)
        .execute()
    : [];
  const overrides = new Map<string, ActionAppliesToDecl>();
  for (const r of overrideRows) {
    overrides.set(r.action_id, r.applies_to_override as ActionAppliesToDecl);
  }
  // An explicit `appliesTo.kinds` allowlist names MODULE kinds, so match it
  // against the base — otherwise "supplies:item" fails an ["inventory:part"]
  // allowlist. Traits and fields still come from the instance's own record
  // above, so this widens who's eligible without flattening what they are.
  const matchKind = orgId ? await baseKindOf(orgId, kind) : kind;
  // The workspace's OWN field roles join the kind's native ones, so an action
  // scoped by `hasFieldRole: "expiry"` appears on the table whose bundle marked
  // a "Best before" field as expiry, and nowhere else. Without this, the
  // matcher only ever saw the module's native fields, and the whole family of
  // perishable verbs had to be scoped to the entire inventory kind.
  const fields = orgId
    ? withWorkspaceFieldRoles(kindRecord.fields, [...(await fieldRolesForKind(orgId, kind))])
    : kindRecord.fields;
  // Match against what the COLLECTION wears, not only what the kind declares:
  // the same laptops are a count in one collection and individuals in
  // another, and the trial axes (goes off, gets lent) exist only here. Without
  // an org there is no collection, so the declaration stands.
  const verdict = orgId ? await facesForKind(orgId, kind) : null;
  const traits = verdict ? (verdict.traits as Record<string, unknown>) : kindRecord.traits;
  // Only the actions of modules this workspace has turned on (#3255), and the
  // ones the caller is about to turn on: a bundle install enables what it
  // requires AFTER it has checked its wires, so judging those wires against
  // today's modules refused every bundle whose wire needed a module the
  // workspace did not have yet, which is most first installs.
  const on = orgId ? await enabledActionOwners(orgId) : null;
  if (on) for (const m of opts.alsoOn ?? []) on.add(m);
  const eligible = allActions
    .filter((a) => !on || (on.has(a.module_name) && (opts.alsoOn?.includes(a.module_name) || on.has(actionOwner(a)))))
    .map(rowToActionRecord)
    .filter((a) =>
      belongsOnEntity(
        a,
        overrides.get(a.id) ?? a.applies_to,
        fields,
        matchKind,
        traits,
      ),
    );
  // Eligibility above is FACTS; this is the person's CHOICE. A face they hid
  // takes its verbs off the record too, without the facts changing.
  const shown = verdict ? disclose(eligible, new Set(verdict.faces)) : eligible;
  return orderForRecord(shown, matchKind.split(":")[0] ?? "");
}

/** What a record WOULD offer if a module that is off here were on: the
 *  actions of this workspace's off modules that apply to the kind, by the same
 *  rule listApplicable judges the enabled ones with. A record shows each as a
 *  door ("Print label, turn on Labels") instead of nothing at all: the owner
 *  looked for label printing on a record while Labels was off, and nothing on
 *  the page said it existed (#3883). Only buttons a person presses: never an
 *  internal or wire-only action. */
export async function listDormant(kind: string, orgId: string): Promise<Array<EntityActionRecord & { module_label: string }>> {
  const on = await enabledActionOwners(orgId);
  const registered = new Map(listEntries().map((e) => [e.manifest.name, e.manifest.displayName] as const));
  const off = [...registered.keys()].filter((m) => !on.has(m));
  if (off.length === 0) return [];
  const offSet = new Set(off);
  const all = await listApplicable(kind, orgId, { alsoOn: off });
  return all
    .filter((a) => offSet.has(a.module_name) && a.user_invokable !== false && !a.internal && !a.wire_only)
    .map((a) => ({ ...a, module_label: registered.get(a.module_name) ?? a.module_name }));
}

/** Native fields plus one `{ role }` entry per workspace role, for the matcher. */
export function withWorkspaceFieldRoles(
  native: { role?: string }[],
  roles: string[],
): { role?: string }[] {
  return roles.length === 0 ? native : [...native, ...roles.map((role) => ({ role }))];
}

/**
 * What a person's face choices leave on the record.
 *
 * An action with no `face` belongs to the base and always stays. One with a
 * face stays only while that face is shown. This is disclosure, applied after
 * eligibility: "Log service" is eligible on every drill (physical, unique) and
 * shown on the ones whose collection has not turned Service off.
 */
export function disclose<T extends { face: string | null }>(actions: T[], shownFaces: ReadonlySet<string>): T[] {
  return actions.filter((a) => !a.face || shownFaces.has(a.face));
}

/**
 * The order a person sees on a record.
 *
 * The record's own module first, in the order it declared them; then every
 * other module's, grouped by module, each in its declared order. Ties fall to
 * the id so the result is stable.
 *
 * Until this existed the list was ordered by id, which is alphabetical by
 * module name first: "core-maintenance:log" and "core-scan:…" led every
 * inventory item and its own "use one" sat behind the fold (2026-09-08).
 */
export function orderForRecord<T extends { id: string; module_name: string; position: number }>(
  actions: T[],
  ownModule: string,
): T[] {
  return [...actions].sort((x, y) => {
    const xo = x.module_name === ownModule ? 0 : 1;
    const yo = y.module_name === ownModule ? 0 : 1;
    if (xo !== yo) return xo - yo;
    if (x.module_name !== y.module_name) return x.module_name < y.module_name ? -1 : 1;
    if (x.position !== y.position) return x.position - y.position;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

/** Read the effective appliesTo for an action in an org's context.
 *  Returns the override if present, else the manifest default. */
export async function effectiveAppliesTo(
  actionId: string,
  orgId: string,
): Promise<{
  effective: ActionAppliesToDecl;
  default: ActionAppliesToDecl;
  overridden: boolean;
}> {
  const row = await meta
    .selectFrom("entity_actions")
    .select("applies_to")
    .where("id", "=", actionId)
    .executeTakeFirst();
  if (!row) throw new Error(`Unknown action: ${actionId}`);
  const defaultPredicate = (row.applies_to as ActionAppliesToDecl) ?? { any: true };
  const ovr = await meta
    .selectFrom("entity_action_org_overrides")
    .select("applies_to_override")
    .where("org_id", "=", orgId)
    .where("action_id", "=", actionId)
    .executeTakeFirst();
  if (ovr) {
    return {
      effective: ovr.applies_to_override as ActionAppliesToDecl,
      default: defaultPredicate,
      overridden: true,
    };
  }
  return { effective: defaultPredicate, default: defaultPredicate, overridden: false };
}

// NOTE ON AUTHORIZATION (2026-06-10 audit #3): this programmatic entry point
// is intentionally NOT capability-gated. The HTTP route POST /actions/invoke
// gates the *caller* with requireCapability; this function is the path wires
// (automation) and recurrence use, where the action must run with the
// authority the wire's AUTHOR configured — an admin-authored "on part create,
// adjust stock" wire legitimately fires when a low-privilege member creates a
// part. The escalation that capability-gating-here would guard against (a
// member wiring up a privileged action they can't invoke) is closed at the
// SOURCE instead: creating wires/bindings + installing bundles now requires
// owner/admin (see routes/platform.ts bindings CRUD + routes/bundles.ts). Do
// not add a triggering-user capability check here — it breaks legitimate
// automation. If finer control is wanted, gate wire CREATION by the target
// action's capability, not wire FIRING.
/** The action's own words for what it does ("Identify a scanned photo"),
 *  for a surface that has only its id. Null for an unknown action. */
export async function actionLabelOf(actionId: string): Promise<string | null> {
  const row = await meta.selectFrom("entity_actions").select("label").where("id", "=", actionId).executeTakeFirst();
  return row?.label?.trim() || null;
}

export async function invoke(
  actionId: string,
  ctx: ActionInvokeContext,
): Promise<unknown> {
  const row = await meta
    .selectFrom("entity_actions")
    .selectAll()
    .where("id", "=", actionId)
    .executeTakeFirst();
  if (!row) throw new Error(`Unknown action: ${actionId}`);
  if (!row.invoke_handler) {
    throw new Error(
      `Action ${actionId} has no programmatic handler (invoke_handler is null) — use its invoke_route instead`,
    );
  }
  const handler = handlers.get(row.invoke_handler);
  if (!handler) {
    throw new Error(
      `Action ${actionId} declared handler "${row.invoke_handler}" but it was never registered`,
    );
  }
  // The door refuses a call it cannot serve, in the same shape a handler
  // refuses with, before the handler runs: a module this workspace has not
  // turned on (#3255), a record that is not there (#3141), then an argument
  // the schema says it needs (#3123). A card that renders and dies on press
  // was a call the door could have refused.
  // The code and the app's name travel with the sentence, so a module that
  // relays this refusal can hand its person the switch, not just the words
  // (#5865). A part that is off answers the same way, naming its part.
  const off = await offRefusal(row, ctx.orgId);
  if (off) return { ok: false, ...off };
  const gone = await missingRecordRefusal(ctx, row.scope === "workspace" ? "workspace" : "entity");
  if (gone) return { ok: false, error: gone };
  const lent = await lentRefusal(actionId, ctx);
  if (lent) return { ok: false, code: "lent_out", error: lent };
  // A boolean argument is a boolean whichever door sent it: a wire's saved
  // "true", a form's text box, the assistant (#6130).
  ctx = { ...ctx, args: typedArgs(row.args_schema as ArgsSchema, ctx.args) };
  const refused = requiredArgsRefusal(actionId, row.args_schema as ArgsSchema, ctx.args);
  if (refused) return { ok: false, error: refused };
  try {
    // One meaning of ok for every reader (action-result.ts): a handler that
    // found nothing to do is declined, not a pass; an answer that does not
    // say whether it ran is a refusal, and is named in the log.
    const answered = normaliseActionResult(await handler(ctx), row.invoke_handler);
    if (answered.malformed) console.error(`[actions] ${actionId} handler ${row.invoke_handler} answered without ok:`, (answered as { raw?: unknown }).raw);
    return answered;
  } catch (err) {
    // The handler is named here, once, where it is known; the caller (the
    // invoke route, the wire engine) answers in its own way.
    console.error(`[actions] ${actionId} handler ${row.invoke_handler} threw:`, err);
    // An id that is not one is the caller's mistake, not a crash: said as a
    // refusal, the model or the person can read the records and try again.
    // It reached a handler's query as "$result..." and answered only
    // "check the log for act-..." (main red, 2026-10-07).
    if (isNotAnId(err)) throw new ActionRefusal("One of the ids given is not an id. Read the records first and pass their real ids.");
    throw err;
  }
}

/** Postgres refusing a value as a uuid (22P02, "invalid input syntax for
 *  type uuid"): a handler was handed an id that is not one. */
function isNotAnId(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === "22P02" && typeof e.message === "string" && /type uuid/.test(e.message);
}

/** Why an action matched (or didn't) an entity kind. `via: null`
 *  means no sub-predicate hit. */
export type MatchReason =
  | { via: "any" }
  | { via: "kinds"; kind: string }
  | { via: "hasFieldRole"; role: string }
  | { via: "traits"; traits: string[] }
  | { via: null };

/** Match an action's predicate against an entity kind, returning
 *  *why* it matched (or that it didn't). The boolean `actionApplies`
 *  is a thin wrapper over this.
 *
 *  Predicate shapes:
 *    - { any: true } — universal match
 *    - { kinds, traits, hasFieldRole } — at least one sub-predicate set;
 *      OR across them (any hitting matches), AND within `traits` (every
 *      axis the predicate names must be satisfied by one of its poles).
 *    - `requires: { traits }` beside them — AND: whichever matched, the
 *      kind must also carry these traits, or nothing matched.
 */
export function matchAction(
  predicate: ActionAppliesToDecl,
  kindFields: { role?: string }[],
  kindId: string,
  kindTraits: Record<string, unknown> | null,
): MatchReason {
  if ("any" in predicate && predicate.any) return { via: "any" };
  const p = predicate as Exclude<ActionAppliesToDecl, { any: true }>;
  const reason = matchAny(p, kindFields, kindId, kindTraits);
  // `requires` is AND: whatever matched, the record must also be this.
  if (reason.via !== null && p.requires?.traits.length && !traitsSatisfied(p.requires.traits, kindTraits)) return { via: null };
  return reason;
}

function matchAny(
  p: Exclude<ActionAppliesToDecl, { any: true }>,
  kindFields: { role?: string }[],
  kindId: string,
  kindTraits: Record<string, unknown> | null,
): MatchReason {
  // OR across kinds / traits / hasFieldRole — first hit wins, and
  // kinds is checked first as the most specific.
  if (p.kinds?.includes(kindId)) return { via: "kinds", kind: kindId };
  if (p.hasFieldRole && kindFields.some((f) => f.role === p.hasFieldRole)) {
    return { via: "hasFieldRole", role: p.hasFieldRole };
  }
  if (p.traits?.length) {
    const satisfiers = traitSatisfiers(p.traits, kindTraits);
    if (satisfiers) return { via: "traits", traits: satisfiers };
  }
  return { via: null };
}

/** The traits that satisfy every axis the list names (within an axis OR,
 *  across AND), or null when one axis goes unmet or none is named. */
function traitSatisfiers(wanted: readonly string[], kindTraits: Record<string, unknown> | null): string[] | null {
  const have = collectTraitValues(kindTraits);
  const byAxis = new Map<AnyAxisName, string[]>();
  for (const t of wanted) {
    // Real or trial axis: a trait word on either matches the same way.
    const axis = axisOfTrait(t);
    if (!axis) continue;
    const list = byAxis.get(axis) ?? [];
    list.push(t);
    byAxis.set(axis, list);
  }
  if (byAxis.size === 0) return null;
  const satisfiers: string[] = [];
  for (const traits of byAxis.values()) {
    const hit = traits.find((t) => have.has(t));
    if (!hit) return null;
    satisfiers.push(hit);
  }
  return satisfiers;
}

function traitsSatisfied(wanted: readonly string[], kindTraits: Record<string, unknown> | null): boolean {
  return traitSatisfiers(wanted, kindTraits) !== null;
}

/** True if the action's predicate matches an entity kind. */
export function actionApplies(
  predicate: ActionAppliesToDecl,
  kindFields: { role?: string }[],
  kindId: string,
  kindTraits: Record<string, unknown> | null,
): boolean {
  return matchAction(predicate, kindFields, kindId, kindTraits).via !== null;
}

/** Pull every trait value out of an entity kind's trait map into a
 *  flat Set so the action matcher can do `have.has("physical")`.
 *  Handles the `{ trait, uncertain }` wrapper shape transparently. */
function collectTraitValues(
  traits: Record<string, unknown> | null,
): Set<string> {
  const out = new Set<string>();
  if (!traits) return out;
  for (const v of Object.values(traits)) {
    if (typeof v === "string") out.add(v);
    else if (
      typeof v === "object" &&
      v !== null &&
      "trait" in v &&
      typeof (v as { trait: unknown }).trait === "string"
    ) {
      out.add((v as { trait: string }).trait);
    }
  }
  return out;
}

function rowToActionRecord(row: {
  id: string;
  module_name: string;
  label: string;
  description: string | null;
  icon: string | null;
  applies_to: unknown;
  scope?: string | null;
  invoke_route: string | null;
  invoke_handler: string | null;
  action_group?: string | null;
  is_primary?: boolean;
  user_invokable?: boolean;
  internal?: boolean;
  wire_only?: boolean;
  record_optional?: boolean;
  finishes?: string | null;
  stock_move?: string | null;
  editor?: boolean;
  args_schema?: unknown;
  version: string;
  position?: number;
  face?: string | null;
  undoable?: boolean;
}): EntityActionRecord {
  return {
    group: row.action_group ?? null,
    primary: row.is_primary ?? false,
    id: row.id,
    module_name: row.module_name,
    label: row.label,
    description: row.description,
    icon: row.icon,
    applies_to: (row.applies_to as ActionAppliesToDecl) ?? { any: true },
    scope: row.scope === "workspace" ? "workspace" : "entity",
    position: row.position ?? 0,
    face: row.face ?? null,
    invoke_route: row.invoke_route,
    invoke_handler: row.invoke_handler,
    user_invokable: row.user_invokable ?? true,
    internal: row.internal ?? false,
    wire_only: row.wire_only ?? false,
    record_optional: row.record_optional ?? false,
    undoable: row.undoable === true,
    finishes: row.finishes === "used" || row.finishes === "discarded" || row.finishes === "still-good" ? row.finishes : null,
    stock_move: row.stock_move === "use" || row.stock_move === "add" || row.stock_move === "total" ? row.stock_move : null,
    editor: row.editor === true,
    args_schema:
      (row.args_schema as EntityActionRecord["args_schema"]) ?? null,
    version: row.version,
  };
}

/** The scope of a single action, or null if the action is unknown. The invoke
 *  route reads this BEFORE resolving an entity: a workspace-scoped action has
 *  no record, so it skips the lookup and requires no entityKind/entityId. */
/** Whether an entity-scoped action may also run with no record (the
 *  manifest's `recordOptional`, #3255). False for an unknown action. */
export async function actionRecordOptional(actionId: string): Promise<boolean> {
  const row = await meta.selectFrom("entity_actions").select("record_optional").where("id", "=", actionId).executeTakeFirst();
  return row?.record_optional === true;
}

export async function getActionScope(
  actionId: string,
): Promise<"entity" | "workspace" | null> {
  const row = await meta
    .selectFrom("entity_actions")
    .select("scope")
    .where("id", "=", actionId)
    .executeTakeFirst();
  if (!row) return null;
  return row.scope === "workspace" ? "workspace" : "entity";
}

// Suppress unused warning — re-exported for tests
export { listKinds };
