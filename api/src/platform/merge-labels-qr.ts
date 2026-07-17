// HISTORICAL DATA MIGRATION — not kernel logic.
// DONE WHEN: org_modules has no 'core-labels-qr' rows and no
// entity_action_bindings row references a 'core-labels-qr.*' event or the
// 'core-labels-qr' source module, on prod + staging + dev consistently; then
// delete this file, its boot call, the /modules/core-labels-qr mount alias,
// and migration 0004's compat views in the same change.
//
// The core-labels-qr module merged into labels (labels 0.6.0). This pass
// converts each workspace's enablement:
//   - labels already enabled → the core-labels-qr row is redundant: DELETE.
//   - core-labels-qr enabled, labels not, and the org has MINTED QR tokens
//     (rows in meta core_labels_qr_tokens) → real usage: RENAME the row to
//     'labels' so the capability survives (labels' tenant migrations run in
//     the same boot via syncTenantMigrations, which follows this pass).
//   - core-labels-qr enabled, labels not, zero tokens → the capability was
//     ambient (autoEnable) but never used: DELETE. The workspace keeps its
//     blank slate; enabling Labels later brings the whole feature back.
// Plus a meta-wide rewrite of wire/binding references to the renamed events
// (the digifab-rename lesson: a rename that leaves stale wires strands them).
//
// The old migration-tracker rows (scope 'core-labels-qr::…') are left as
// inert residue on purpose: the runner only consults scopes for registered
// modules, and labels' 0004 is written to converge from either start state.
// Meta-only; opens no tenant pools. Idempotent. Skip with
// COBBLR_SKIP_HISTORICAL_MIGRATIONS=1.

import { sql } from "kysely";
import { meta } from "../db/meta.js";

export async function mergeLabelsQr(): Promise<{ renamed: number; deleted: number; wiresRewritten: number }> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") {
    return { renamed: 0, deleted: 0, wiresRewritten: 0 };
  }
  const rows = await meta
    .selectFrom("org_modules")
    .select(["org_id"])
    .where("module_name", "=", "core-labels-qr")
    .execute();

  let renamed = 0;
  let deleted = 0;
  for (const { org_id } of rows) {
    try {
      const hasLabels = await meta
        .selectFrom("org_modules")
        .select("module_name")
        .where("org_id", "=", org_id)
        .where("module_name", "=", "labels") // HISTORICAL DATA MIGRATION names the module it heals
        .executeTakeFirst();
      if (hasLabels) {
        await meta
          .deleteFrom("org_modules")
          .where("org_id", "=", org_id)
          .where("module_name", "=", "core-labels-qr")
          .execute();
        deleted++;
        continue;
      }
      const minted = await meta
        .selectFrom("core_labels_qr_tokens" as never)
        .select(sql`1`.as("x"))
        .where("org_id" as never, "=", org_id as never)
        .limit(1)
        .executeTakeFirst();
      if (minted) {
        await meta
          .updateTable("org_modules")
          .set({ module_name: "labels" }) // HISTORICAL DATA MIGRATION names the module it heals
          .where("org_id", "=", org_id)
          .where("module_name", "=", "core-labels-qr")
          .execute();
        renamed++;
      } else {
        await meta
          .deleteFrom("org_modules")
          .where("org_id", "=", org_id)
          .where("module_name", "=", "core-labels-qr")
          .execute();
        deleted++;
      }
    } catch (err) {
      console.error(`[merge-labels-qr] org ${org_id} failed:`, (err as Error).message);
    }
  }

  // Stale-wire rewrite, meta-wide: events renamed core-labels-qr.* → labels.qr.*.
  const rewrote = await meta
    .updateTable("entity_action_bindings")
    .set({
      trigger_event: sql`'labels.qr.' || substring(trigger_event from ${"core-labels-qr.".length + 1})` as never,
    })
    .where("trigger_event", "like", "core-labels-qr.%")
    .executeTakeFirst();
  await meta
    .updateTable("entity_action_bindings")
    .set({ source_module: "labels" }) // HISTORICAL DATA MIGRATION names the module it heals
    .where("source_module", "=", "core-labels-qr")
    .execute();

  const wiresRewritten = Number(rewrote?.numUpdatedRows ?? 0n);
  return { renamed, deleted, wiresRewritten };
}
