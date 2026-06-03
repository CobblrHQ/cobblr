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
import { listKinds, getKind } from "./entities.js";

const handlers = new Map<string, ActionHandler>();

export function registerHandler(handlerKey: string, handler: ActionHandler): void {
  handlers.set(handlerKey, handler);
}

export async function listApplicable(
  kind: string,
  orgId?: string,
): Promise<EntityActionRecord[]> {
  const kindRecord = await getKind(kind);
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
  return allActions
    .map(rowToActionRecord)
    .filter((a) => {
      const predicate = overrides.get(a.id) ?? a.applies_to;
      return actionApplies(predicate, kindRecord.fields, kind, kindRecord.traits);
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
    invoke_route: row.invoke_route,
    invoke_handler: row.invoke_handler,
    user_invokable: row.user_invokable ?? true,
    args_schema:
      (row.args_schema as EntityActionRecord["args_schema"]) ?? null,
    version: row.version,
  };
}

// Suppress unused warning — re-exported for tests
export { listKinds };
