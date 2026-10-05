// PERMANENT RECONCILE — not a one-shot heal: modules ship new default wires
// over time, so this top-up runs for the life of the platform.
//
// BORN WITH: enableModuleForOrg (inserts the manifest's wires as it enables the module; this pass tops up wires added to a manifest since)
//
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
// It is a catch-up pass, not a historical upgrade, so it does NOT honour
// COBBLR_SKIP_HISTORICAL_MIGRATIONS. It once did, on the reasoning that CI's
// org pool is baked by current code; the pool is baked NIGHTLY, so a pull
// request that adds a default wire ran against pooled workspaces that never
// had it, and every pooled test of that wire failed while a fresh signup
// passed (the pool parity test named it, #4050). lint:permanent-reconcile-runs
// keeps every PERMANENT RECONCILE off that flag.
//
// Cheap on the happy path: one read of the existing default wires and one of
// org_modules, a diff in memory, and inserts only for what is missing. No
// tenant pool is opened.
//
// Kernel knows nothing about specific modules here — it iterates the
// registry. Adding a default wire = edit the module's manifest. No
// kernel patch required.

import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import { notePassFailure } from "./pass-failures.js";

function keyOf(orgId: string, sourceKind: string, actionId: string, triggerEvent: string | null, moduleName: string): string {
  return [orgId, sourceKind, actionId, triggerEvent ?? "", moduleName].join("\u0000");
}

/** Backfill: for every (org, module) in org_modules, top up any wires the
 *  module's manifest declares but the workspace doesn't have yet. Idempotent
 *  per (org, source_kind, action_id, trigger_event, source_module). */
export async function backfillDefaultBindings(): Promise<number> {
  const wiresByModule = new Map<string, ReturnType<typeof listEntries>[number]["manifest"]["contributes"]["wires"]>();
  for (const e of listEntries()) {
    if (e.manifest.contributes.wires.length > 0) wiresByModule.set(e.manifest.name, e.manifest.contributes.wires);
  }
  if (wiresByModule.size === 0) return 0;
  const modules = [...wiresByModule.keys()];

  const [enabled, existing] = await Promise.all([
    meta.selectFrom("org_modules").select(["org_id", "module_name"]).where("module_name", "in", modules).execute(),
    meta
      .selectFrom("entity_action_bindings")
      .select(["org_id", "source_kind", "action_id", "trigger_event", "source_module"])
      .where("source_module", "in", modules)
      .execute(),
  ]);
  const have = new Set(existing.map((b) => keyOf(b.org_id, b.source_kind, b.action_id, b.trigger_event, b.source_module!)));

  let total = 0;
  for (const r of enabled) {
    const missing = (wiresByModule.get(r.module_name) ?? []).filter(
      (w) => !have.has(keyOf(r.org_id, w.source_kind, w.action_id, w.trigger_event ?? null, r.module_name)),
    );
    if (missing.length === 0) continue;
    try {
      await meta
        .insertInto("entity_action_bindings")
        .values(
          missing.map((w) => ({
            org_id: r.org_id,
            source_kind: w.source_kind,
            action_id: w.action_id,
            trigger_type: w.trigger_type,
            trigger_event: w.trigger_event ?? null,
            template: w.template ?? null,
            source_module: r.module_name,
          })),
        )
        .execute();
      total += missing.length;
      console.log(`[seed-bindings] org ${r.org_id}: added ${missing.length} default wire(s) for ${r.module_name}`);
    } catch (err) {
      notePassFailure("backfillDefaultBindings", r.org_id, err);
      console.error(`[seed-bindings] backfill failed for org ${r.org_id} / module ${r.module_name}:`, err);
    }
  }
  return total;
}
