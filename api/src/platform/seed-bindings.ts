// Manifest-driven default wires. Every module's
// `manifest.contributes.wires[]` describes user-editable bindings the
// platform should install when the module gets enabled — the actual
// insertion happens inside `enableModuleForOrg`, co-located with the
// rest of the module's contributions.
//
// This file backfills: for every existing (org, module) pair, top up
// any wires the manifest declares that aren't yet in
// `entity_action_bindings`. That covers two cases:
//   1. An org that was created before a wire was added to the manifest
//      (the original "default bindings" seed-on-signup path).
//   2. A wire whose source_module record was deleted and needs re-
//      asserting on next boot.
//
// Kernel knows nothing about specific modules here — it iterates the
// registry. Adding a default wire = edit the module's manifest. No
// kernel patch required.

import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";

/** Top up missing default bindings for one (org, module). Idempotent
 *  per (org, source_kind, action_id, trigger_event, source_module). */
async function topUpForModule(orgId: string, moduleName: string): Promise<number> {
  const entry = listEntries().find((e) => e.manifest.name === moduleName);
  if (!entry) return 0;
  const wires = entry.manifest.contributes.wires;
  let inserted = 0;
  for (const w of wires) {
    const existing = await meta
      .selectFrom("entity_action_bindings")
      .select("id")
      .where("org_id", "=", orgId)
      .where("source_kind", "=", w.source_kind)
      .where("action_id", "=", w.action_id)
      .where("trigger_event", w.trigger_event ? "=" : "is", w.trigger_event ?? null)
      .where("source_module", "=", moduleName)
      .executeTakeFirst();
    if (existing) continue;
    await meta
      .insertInto("entity_action_bindings")
      .values({
        org_id: orgId,
        source_kind: w.source_kind,
        action_id: w.action_id,
        trigger_type: w.trigger_type,
        trigger_event: w.trigger_event ?? null,
        template: w.template ?? null,
        source_module: moduleName,
      })
      .execute();
    inserted++;
  }
  return inserted;
}

/** Backfill: for every (org, module) in org_modules, top up any wires
 *  the module's manifest declares but the workspace doesn't have yet.
 *  Cheap — one query + N idempotent inserts per (org, module). */
export async function backfillDefaultBindings(): Promise<number> {
  const rows = await meta
    .selectFrom("org_modules")
    .select(["org_id", "module_name"])
    .execute();
  let total = 0;
  for (const r of rows) {
    try {
      total += await topUpForModule(r.org_id, r.module_name);
    } catch (err) {
      console.error(
        `[seed-bindings] backfill failed for org ${r.org_id} / module ${r.module_name}:`,
        err,
      );
    }
  }
  return total;
}
