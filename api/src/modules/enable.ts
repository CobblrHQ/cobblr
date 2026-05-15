// Module enablement. Turns "module X is installed for org Y" into
// real state: tenant DB has X's tables, cobblr_meta.org_modules has
// the row.
//
// Idempotent — calling twice for the same (org, module) is a no-op.
// Failing partway through (migrations applied but row not inserted,
// or vice versa) leaves the system recoverable: a later re-run picks
// up where it left off because each migration tracks itself in the
// tenant DB's own `migrations` table.

import { resolve } from "node:path";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { runMigrations } from "../db/migrate.js";
import { getTenantPool } from "../db/tenant.js";
import { getEntry, listEntries } from "./registry.js";
import * as activity from "../platform/activity.js";

export interface EnableResult {
  alreadyEnabled: boolean;
  migrationsApplied: number;
  lastMigration: string | null;
}

export async function enableModuleForOrg(
  orgId: string,
  moduleName: string,
  options: { userId?: string } = {},
): Promise<EnableResult> {
  const entry = getEntry(moduleName);
  if (!entry) {
    throw new Error(`Module not registered: ${moduleName}`);
  }

  // Pillar E — every declared dep must be enabled for this org
  // before we let this one on. Avoid surprising users by NOT
  // auto-cascading the enable (transparency over magic).
  for (const dep of entry.manifest.dependencies) {
    const depRow = await meta
      .selectFrom("org_modules")
      .select("module_name")
      .where("org_id", "=", orgId)
      .where("module_name", "=", dep)
      .executeTakeFirst();
    if (!depRow) {
      throw new Error(
        `Module ${moduleName} requires ${dep} — enable ${dep} first.`,
      );
    }
  }

  const existing = await meta
    .selectFrom("org_modules")
    .select(["version", "last_migration"])
    .where("org_id", "=", orgId)
    .where("module_name", "=", moduleName)
    .executeTakeFirst();
  if (existing) {
    return {
      alreadyEnabled: true,
      migrationsApplied: 0,
      lastMigration: existing.last_migration,
    };
  }

  // Pillar-E specialisation modules can omit `schema` entirely
  // when they don't own any tables. Skip the migration runner in
  // that case — the module is purely a contributions container.
  let lastMigration: string | null = null;
  let migrationsApplied: string[] = [];
  if (entry.manifest.schema) {
    const migrationsDir = resolve(entry.rootPath, entry.manifest.schema.migrationsDir);
    const pool = await getTenantPool(orgId);
    const result = await runMigrations({
      pool,
      directory: migrationsDir,
      scope: `tenant ${orgId} / module ${moduleName}`,
    });
    migrationsApplied = result.applied;
    lastMigration =
      result.applied.length > 0
        ? result.applied[result.applied.length - 1] ?? null
        : null;
  }

  await meta
    .insertInto("org_modules")
    .values({
      org_id: orgId,
      module_name: moduleName,
      version: entry.manifest.version,
      last_migration: lastMigration,
    })
    .execute();

  // Pillar E — apply contributed field-defs + wires. Tagged with
  // source_module so disable can clean them up. Idempotent via
  // existence checks; safe to re-run.
  const contributes = entry.manifest.contributes;
  for (const fd of contributes.fieldDefs) {
    await meta
      .insertInto("module_field_defs")
      .values({
        org_id: orgId,
        entity_kind: fd.entity_kind,
        name: fd.name,
        display_label: fd.display_label,
        type: fd.type,
        required: fd.required ?? false,
        position: fd.position ?? 0,
        source_module: moduleName,
        choices: fd.choices
          ? (sql`${JSON.stringify(fd.choices)}::jsonb` as unknown as string[])
          : null,
      })
      .onConflict((b) => b.columns(["org_id", "entity_kind", "name"]).doNothing())
      .execute();
  }
  for (const w of contributes.wires) {
    // No idempotency key on bindings; skip if a binding from this
    // module already exists for the (source_kind, action_id,
    // trigger_event) triple.
    const dup = await meta
      .selectFrom("entity_action_bindings")
      .select("id")
      .where("org_id", "=", orgId)
      .where("source_module", "=", moduleName)
      .where("source_kind", "=", w.source_kind)
      .where("action_id", "=", w.action_id)
      .where("trigger_event", w.trigger_event ? "=" : "is", w.trigger_event ?? null)
      .executeTakeFirst();
    if (dup) continue;
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
  }

  try {
    await activity.log({
      orgId,
      userId: options.userId ?? null,
      action: "module_enabled",
      ref: { module: null, entityType: "org_module", entityId: moduleName },
      diff: {
        version: entry.manifest.version,
        migrations: migrationsApplied,
        contributed_field_defs: contributes.fieldDefs.length,
        contributed_wires: contributes.wires.length,
      },
    });
  } catch (err) {
    console.error(`[enable] activity logging failed for ${moduleName}:`, err);
  }

  void sql; // re-export kept in case future cleanup needs it
  return { alreadyEnabled: false, migrationsApplied: migrationsApplied.length, lastMigration };
}

/** Disable a module for an org. Removes the org_modules row + any
 *  field-defs/wires the module contributed via Pillar E.
 *  The tenant tables (the module's own data) are NOT dropped — that
 *  would be data loss. Re-enable later and the data is still there.
 *  Cascading disable: refuses if another enabled module depends on this
 *  one.
 */
export async function disableModuleForOrg(orgId: string, moduleName: string): Promise<void> {
  // Refuse if a dependent module is still enabled.
  const allEntries = listEntries();
  const dependents = allEntries
    .filter((e) => e.manifest.dependencies.includes(moduleName))
    .map((e) => e.manifest.name);
  if (dependents.length > 0) {
    const stillOn = await meta
      .selectFrom("org_modules")
      .select("module_name")
      .where("org_id", "=", orgId)
      .where("module_name", "in", dependents)
      .execute();
    if (stillOn.length > 0) {
      throw new Error(
        `Cannot disable ${moduleName}: still required by ${stillOn.map((s) => s.module_name).join(", ")}.`,
      );
    }
  }
  await meta
    .deleteFrom("module_field_defs")
    .where("org_id", "=", orgId)
    .where("source_module", "=", moduleName)
    .execute();
  await meta
    .deleteFrom("entity_action_bindings")
    .where("org_id", "=", orgId)
    .where("source_module", "=", moduleName)
    .execute();
  await meta
    .deleteFrom("org_modules")
    .where("org_id", "=", orgId)
    .where("module_name", "=", moduleName)
    .execute();
  try {
    await activity.log({
      orgId,
      action: "module_disabled",
      ref: { module: null, entityType: "org_module", entityId: moduleName },
    });
  } catch (err) {
    console.error(`[disable] activity logging failed for ${moduleName}:`, err);
  }
}

/** Convenience: enable every base module (no `dependencies`) for a
 *  fresh org. Phase 1 dev shortcut so signup → working inventory in
 *  one step. Pillar-E modules with deps require an explicit enable
 *  via POST /orgs/:slug/modules/:name/enable — most users don't
 *  want every specialization installed by default. */
export async function enableAllForOrg(orgId: string, userId?: string): Promise<string[]> {
  const enabled: string[] = [];
  for (const entry of listEntries()) {
    if (entry.manifest.dependencies.length > 0) continue;
    try {
      const result = await enableModuleForOrg(orgId, entry.manifest.name, { userId });
      if (!result.alreadyEnabled) enabled.push(entry.manifest.name);
    } catch (err) {
      console.error(`[enable] failed for ${entry.manifest.name} on org ${orgId}:`, err);
    }
  }
  return enabled;
}
