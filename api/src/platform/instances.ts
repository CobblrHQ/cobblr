// Module instances service. A workspace can install one module
// multiple times under different instance names; this is the platform
// service that creates / lists / deletes those rows and exposes
// helpers other code paths (route resolution, registry sync) use.
//
// See docs/design-decisions/instances.md for the full design.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getEntry } from "../modules/registry.js";

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

/** Build the display name from a slug, used when the user doesn't
 *  explicitly supply one (e.g., the default instance created by
 *  enableModuleForOrg uses the module's displayName from the
 *  manifest if available, else this fallback). */
export function defaultDisplayName(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
