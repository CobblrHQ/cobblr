// Capability Registry runtime. Mirrors entities.ts but for actions
// rather than entities.

import type {
  ActionAppliesToDecl,
  ActionHandler,
  ActionInvokeContext,
  AxisName,
  EntityActionRecord,
  TraitName,
} from "@cobblr/platform-contract";
import { AXIS_OF_TRAIT } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { listKinds, getKind, listKindsForOrg, baseKindOf } from "./entities.js";

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
  return actionApplies(predicate, fields, matchKind, traits);
}

export async function listApplicable(
  kind: string,
  orgId?: string,
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
  return allActions
    .map(rowToActionRecord)
    .filter((a) =>
      belongsOnEntity(
        a,
        overrides.get(a.id) ?? a.applies_to,
        kindRecord.fields,
        matchKind,
        kindRecord.traits,
      ),
    );
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
  return handler(ctx);
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
 */
export function matchAction(
  predicate: ActionAppliesToDecl,
  kindFields: { role?: string }[],
  kindId: string,
  kindTraits: Record<string, unknown> | null,
): MatchReason {
  if ("any" in predicate && predicate.any) return { via: "any" };
  const p = predicate as Exclude<ActionAppliesToDecl, { any: true }>;
  // OR across kinds / traits / hasFieldRole — first hit wins, and
  // kinds is checked first as the most specific.
  if (p.kinds?.includes(kindId)) return { via: "kinds", kind: kindId };
  if (p.hasFieldRole && kindFields.some((f) => f.role === p.hasFieldRole)) {
    return { via: "hasFieldRole", role: p.hasFieldRole };
  }
  if (p.traits?.length) {
    const have = collectTraitValues(kindTraits);
    // Group required traits by axis: within an axis OR, across AND.
    const byAxis = new Map<AxisName, TraitName[]>();
    for (const t of p.traits as string[]) {
      const axis = (AXIS_OF_TRAIT as Record<string, AxisName>)[t];
      if (!axis) continue;
      const list = byAxis.get(axis) ?? [];
      list.push(t as TraitName);
      byAxis.set(axis, list);
    }
    if (byAxis.size > 0) {
      // For each axis, the trait that satisfied it (if any).
      const satisfiers: string[] = [];
      let allSatisfied = true;
      for (const traits of byAxis.values()) {
        const hit = traits.find((t) => have.has(t));
        if (hit) satisfiers.push(hit);
        else allSatisfied = false;
      }
      if (allSatisfied) return { via: "traits", traits: satisfiers };
    }
  }
  return { via: null };
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
  user_invokable?: boolean;
  args_schema?: unknown;
  version: string;
}): EntityActionRecord {
  return {
    id: row.id,
    module_name: row.module_name,
    label: row.label,
    description: row.description,
    icon: row.icon,
    applies_to: (row.applies_to as ActionAppliesToDecl) ?? { any: true },
    scope: row.scope === "workspace" ? "workspace" : "entity",
    invoke_route: row.invoke_route,
    invoke_handler: row.invoke_handler,
    user_invokable: row.user_invokable ?? true,
    args_schema:
      (row.args_schema as EntityActionRecord["args_schema"]) ?? null,
    version: row.version,
  };
}

/** The scope of a single action, or null if the action is unknown. The invoke
 *  route reads this BEFORE resolving an entity: a workspace-scoped action has
 *  no record, so it skips the lookup and requires no entityKind/entityId. */
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
