// Module instances service. A workspace can install one module
// multiple times under different instance names; this is the platform
// service that creates / lists / deletes those rows and exposes
// helpers other code paths (route resolution, registry sync) use.
//
// See docs/architecture/instances.md for the full design.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getEntry } from "../modules/registry.js";
import { getTenantDb } from "../db/tenant.js";
import { deleteOverride } from "./entity-kind-overrides.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ModuleInstance {
  id: string;
  org_id: string;
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default: boolean;
  config: Record<string, unknown>;
  created_at: Date;
}

export interface CreateInstanceArgs {
  orgId: string;
  moduleName: string;
  instanceName: string;
  displayName: string;
  isDefault?: boolean;
  config?: Record<string, unknown>;
}

/** Validate the slug + the module supports multi-instance. Throws on
 *  failure with a code the route layer maps to 400/409. */
function validateInstanceCreate(args: CreateInstanceArgs): void {
  if (!SLUG_RE.test(args.instanceName)) {
    throw Object.assign(
      new Error(`Instance name '${args.instanceName}' must be lowercase letters/digits/hyphens.`),
      { code: "invalid_slug" },
    );
  }
  const entry = getEntry(args.moduleName);
  if (!entry) {
    throw Object.assign(
      new Error(`Module '${args.moduleName}' isn't registered with the platform.`),
      { code: "unknown_module" },
    );
  }
  // Default install (is_default=true) always allowed regardless of
  // instanceability — every module's first install is the default.
  // Subsequent installs only allowed for 'multi' modules.
  if (!args.isDefault && entry.manifest.instanceability !== "multi") {
    throw Object.assign(
      new Error(
        `Module '${args.moduleName}' declares instanceability='single' — only one instance per workspace.`,
      ),
      { code: "module_is_single_instance" },
    );
  }
}

/** Create a workspace_module_instances row. Used by enableModuleForOrg
 *  for the default install and by the user-facing "+ New thing" funnel
 *  for additional instances. */
export async function createInstance(args: CreateInstanceArgs): Promise<ModuleInstance> {
  validateInstanceCreate(args);
  const inserted = await meta
    .insertInto("workspace_module_instances")
    .values({
      org_id: args.orgId,
      module_name: args.moduleName,
      instance_name: args.instanceName,
      display_name: args.displayName,
      is_default: args.isDefault ?? false,
      config: sql`${JSON.stringify(args.config ?? {})}::jsonb` as never,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return inserted as ModuleInstance;
}

/** List all instances for a workspace, optionally filtered by module. */
export async function listInstances(
  orgId: string,
  moduleName?: string,
): Promise<ModuleInstance[]> {
  let q = meta
    .selectFrom("workspace_module_instances")
    .selectAll()
    .where("org_id", "=", orgId);
  if (moduleName) q = q.where("module_name", "=", moduleName);
  return (await q.orderBy("module_name").orderBy("created_at").execute()) as ModuleInstance[];
}

/** Look up a single instance by (org, instance_name). The instance_name
 *  is workspace-unique across all modules (the funnel UI enforces it
 *  at create time) so the module_name isn't needed for the lookup. */
export async function getInstance(
  orgId: string,
  instanceName: string,
): Promise<ModuleInstance | null> {
  const row = await meta
    .selectFrom("workspace_module_instances")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("instance_name", "=", instanceName)
    .executeTakeFirst();
  return (row as ModuleInstance | undefined) ?? null;
}

/** Get the default instance for a (workspace, module). Used by
 *  backward-compat code paths that hit /modules/<m>/<r> URLs. */
export async function getDefaultInstance(
  orgId: string,
  moduleName: string,
): Promise<ModuleInstance | null> {
  const row = await meta
    .selectFrom("workspace_module_instances")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("module_name", "=", moduleName)
    .where("is_default", "=", true)
    .executeTakeFirst();
  return (row as ModuleInstance | undefined) ?? null;
}

/** Delete a non-default instance. Default instances live + die with
 *  the module's enable/disable lifecycle; they can't be deleted
 *  individually. The caller is responsible for cleaning up the
 *  module's tenant-side rows (DELETE WHERE instance='<name>') —
 *  this is module-specific and the platform doesn't know which
 *  tables exist. */
export async function deleteInstance(
  orgId: string,
  instanceName: string,
): Promise<void> {
  const row = await getInstance(orgId, instanceName);
  if (!row) {
    throw Object.assign(new Error("Instance not found."), { code: "not_found" });
  }
  if (row.is_default) {
    throw Object.assign(
      new Error(`Cannot delete the default instance '${instanceName}' — disable the module instead.`),
      { code: "cannot_delete_default" },
    );
  }
  await meta
    .deleteFrom("workspace_module_instances")
    .where("id", "=", row.id)
    .execute();
}

/** Full teardown of a NON-default instance: its tenant-side data rows, its
 *  `workspace_module_instances` row, and its nav/presentation override. Shared by
 *  the DELETE /instances/:name route AND bundle uninstall (refcount teardown).
 *  Best-effort on the tenant data (orphaned rows beat a half-deleted instance).
 *  No-op when the instance is missing or is the default. */
export async function tearDownInstance(orgId: string, instanceName: string): Promise<void> {
  const inst = await getInstance(orgId, instanceName);
  if (!inst || inst.is_default) return;
  const entry = getEntry(inst.module_name);
  if (entry?.manifest.schema) {
    const prefix = entry.manifest.schema.tablePrefix;
    try {
      const tdb = (await getTenantDb(orgId)) as unknown as {
        executeQuery: (s: unknown) => Promise<{ rows: Array<{ table_name: string }> }>;
      };
      const { rows } = await tdb.executeQuery(
        sql`select table_name from information_schema.tables where table_schema='public' and table_name like ${prefix + "%"}`.compile(
          tdb as never,
        ),
      );
      for (const r of rows) {
        // Bind the instance value rather than interpolate it; quote the table
        // name via sql.ref (it's from information_schema, prefix-filtered).
        // (Audit 2026-06-26 P2.)
        await (tdb as unknown as { executeQuery: (s: unknown) => Promise<unknown> }).executeQuery(
          sql`delete from ${sql.ref(r.table_name)} where instance = ${instanceName}`.compile(tdb as never),
        );
      }
    } catch (err) {
      console.error(`[instances] tenant cleanup for ${inst.module_name}/${instanceName} failed:`, err);
    }
  }
  await meta.deleteFrom("workspace_module_instances").where("id", "=", inst.id).execute();
  await deleteOverride(orgId, "instance", `${inst.module_name}:${instanceName}`);
}

/** Build the display name from a slug, used when the user doesn't
 *  explicitly supply one (e.g., the default instance created by
 *  enableModuleForOrg uses the module's displayName from the
 *  manifest if available, else this fallback). */
export function defaultDisplayName(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Per-instance item counters (multi-instance nav cleanup) ──────────
// A multi-instance module registers a counter so the kernel can ask "how many
// primary items live in (org, instance)?" without knowing the module's tables.
// Used to hide an auto-created default instance that's empty once the workspace
// has named instances. See web/src/components/useNavModules.ts.
const itemCounters = new Map<
  string,
  (orgId: string, instanceName: string) => Promise<number>
>();

export function registerItemCounter(
  moduleName: string,
  counter: (orgId: string, instanceName: string) => Promise<number>,
): void {
  itemCounters.set(moduleName, counter);
}

/** Count primary items in (org, module, instance). null = the module
 *  registered no counter, or the count failed — never breaks the list. */
export async function countInstanceItems(
  orgId: string,
  moduleName: string,
  instanceName: string,
): Promise<number | null> {
  const fn = itemCounters.get(moduleName);
  if (!fn) return null;
  try {
    return await fn(orgId, instanceName);
  } catch (err) {
    console.error(
      `[instances] item count failed for ${moduleName}/${instanceName}:`,
      (err as Error).message,
    );
    return null;
  }
}
