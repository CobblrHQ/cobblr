// One-time, idempotent self-heal for a bundle's wire installed at both scopes.
// DONE WHEN: no `entity_action_bindings` rows with the same (org_id, bundle_id,
// trigger_event, action_id, args) where one row's source_kind is the base kind
// of another's instance kind, on prod + staging + dev consistently; then delete
// this file and its boot call.
//
// Three bundles (Groceries, Spice Rack, Tea) declared their wires at the top
// level on inventory:part AND inside their instance on `<instance>:item`. Both
// rows were installed, both fire for one event, and checking milk off the
// shopping list added 2 and filed two purchases (2026-09-12). The bundles no
// longer declare the twin and lint:bundle-content refuses one, so a re-install
// or the bundle-update reconcile replaces the rows. But an update that is held
// for the prompt (a field the person renamed, a module to enable) keeps the old
// rows, and the wire engine's one-firing-one-action rule only masks them. This
// drops the top-level twin where the instance row exists, bundle-owned rows
// only: a wire a person authored is never touched.
//
// Cheap on the happy path: one cobblr_meta query over bundle-owned event
// bindings, grouped in memory; kind resolution runs only for a group that has
// more than one row. No tenant pool.

import { meta } from "../db/meta.js";
import { baseKindOf } from "./entities.js";
import { canonicalArgs, twinsToDrop } from "./twin-wires-rule.js";

interface Row {
  id: string;
  org_id: string;
  bundle_id: string | null;
  source_kind: string;
  action_id: string;
  trigger_event: string | null;
  args: unknown;
  created_at: Date;
}

export async function healTwinBundleWires(): Promise<{ orgsHealed: number; rowsDropped: number }> {
  const rows = (await meta
    .selectFrom("entity_action_bindings")
    .select(["id", "org_id", "bundle_id", "source_kind", "action_id", "trigger_event", "args", "created_at"])
    .where("bundle_id", "is not", null)
    .where("trigger_type", "=", "event")
    .execute()) as Row[];

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = [r.org_id, r.bundle_id, r.trigger_event, r.action_id, canonicalArgs(r.args)].join("|");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  let rowsDropped = 0;
  const healedOrgs = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const orgId = group[0]!.org_id;
    try {
      const bases = new Map<string, string>();
      for (const r of group) if (!bases.has(r.source_kind)) bases.set(r.source_kind, await baseKindOf(orgId, r.source_kind));
      const drop = twinsToDrop(group, (k) => bases.get(k) ?? k);
      if (drop.length === 0) continue;
      await meta.deleteFrom("entity_action_bindings").where("id", "in", drop).execute();
      rowsDropped += drop.length;
      healedOrgs.add(orgId);
      console.log(`[reconcile] org ${orgId}: dropped ${drop.length} twin wire(s) for ${group[0]!.trigger_event} -> ${group[0]!.action_id}`);
    } catch (err) {
      console.error(`[reconcile] org ${orgId}: twin wires failed:`, (err as Error).message);
    }
  }
  return { orgsHealed: healedOrgs.size, rowsDropped };
}
