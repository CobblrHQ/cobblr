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
import { deleteOverride, getOverrideConfig, upsertOverride } from "./entity-kind-overrides.js";
import { fillItemNounIfAbsent } from "./override-config-merge.js";
import { removeNavMember } from "./nav-headings.js";
import { singularize, pluralize } from "../lib/inflect.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ModuleInstance {
  id: string;
  org_id: string;
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default: boolean;
  /** The workspace's designated catch-all for this module — where a scan that
   *  matches no table in particular lands, to then be told apart by its category.
   *  At most one per (org, module); unset everywhere = use the default instance. */
  is_scan_fallback: boolean;
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

/**
 * Designate this instance as its module's scan fallback — the catch-all a scan
 * lands in when it matches no table in particular, to then be told apart by its
 * category rather than by being flung at a near-synonym table.
 *
 * Exclusive per (org, module): clearing the previous holder and setting the new
 * one happen in ONE transaction, because a partial unique index means "two
 * fallbacks" isn't a bad state we'd have to reconcile later — it's a constraint
 * violation that would fail the request halfway.
 */
export async function setScanFallback(orgId: string, instanceName: string): Promise<ModuleInstance> {
  return meta.transaction().execute(async (trx) => {
    const inst = await trx
      .selectFrom("workspace_module_instances")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("instance_name", "=", instanceName)
      .executeTakeFirst();
    if (!inst) throw Object.assign(new Error("instance not found"), { code: "instance_not_found" });
    await trx
      .updateTable("workspace_module_instances")
      .set({ is_scan_fallback: false })
      .where("org_id", "=", orgId)
      .where("module_name", "=", inst.module_name)
      .execute();
    const row = await trx
      .updateTable("workspace_module_instances")
      .set({ is_scan_fallback: true })
      .where("id", "=", inst.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as ModuleInstance;
  });
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

type TenantQuery = { executeQuery: (s: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> };

/** The module's tenant tables that carry an `instance` column: the only ones an
 *  instance's rows can live in, in a stable order. Teardown deletes from these
 *  and nothing else; the row count reads these and nothing else, so the two
 *  agree on what "this instance's data" means. */
async function instanceTables(tdb: TenantQuery, prefix: string): Promise<string[]> {
  const { rows } = await tdb.executeQuery(
    sql`select table_name from information_schema.columns where table_schema='public' and table_name like ${prefix + "%"} and column_name = 'instance' order by table_name`.compile(
      tdb as never,
    ),
  );
  return rows.map((r) => String(r.table_name));
}

/** How many rows, across every table of its module that scopes by instance,
 *  belong to this instance: the exact number a teardown would delete. Null when
 *  the instance is missing or its module owns no tables. Unlike the module's
 *  registered item counter this includes archived records and side tables
 *  (moves, units), which is the number that matters before removing anything. */
export async function instanceRowCount(orgId: string, instanceName: string): Promise<number | null> {
  const inst = await getInstance(orgId, instanceName);
  if (!inst) return null;
  const entry = getEntry(inst.module_name);
  if (!entry?.manifest.schema) return null;
  const tdb = (await getTenantDb(orgId)) as unknown as TenantQuery;
  let total = 0;
  for (const table of await instanceTables(tdb, entry.manifest.schema.tablePrefix)) {
    const { rows } = await tdb.executeQuery(
      sql`select count(*)::int as n from ${sql.ref(table)} where instance = ${instanceName}`.compile(tdb as never),
    );
    total += Number(rows[0]?.n ?? 0);
  }
  return total;
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
      const tdb = (await getTenantDb(orgId)) as unknown as TenantQuery;
      // Only the module's tables that HAVE an instance column. The loop used
      // to run `delete ... where instance = ...` over every prefixed table in
      // information_schema order and die on the first one without the column,
      // having already deleted from the ones before it: a partial teardown
      // whose extent depended on catalog order (#2889, staging, 2026-09-13).
      for (const table of await instanceTables(tdb, prefix)) {
        // Bind the instance value rather than interpolate it; quote the table
        // name via sql.ref (it's from information_schema, prefix-filtered).
        // (Audit 2026-06-26 P2.) Each table on its own: one failure is logged
        // and the rest still run, so what remains is never catalog-order luck.
        try {
          await tdb.executeQuery(sql`delete from ${sql.ref(table)} where instance = ${instanceName}`.compile(tdb as never));
        } catch (err) {
          console.error(`[instances] tenant cleanup for ${inst.module_name}/${instanceName}: ${table} failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[instances] tenant cleanup for ${inst.module_name}/${instanceName} failed:`, err);
    }
  }
  await meta.deleteFrom("workspace_module_instances").where("id", "=", inst.id).execute();
  await deleteOverride(orgId, "instance", `${inst.module_name}:${instanceName}`);
  // Drop any navbar-menu (heading) membership for this instance. Without this a
  // deleted category leaves a dangling member row that would silently RESURRECT
  // the category into the menu if a same-named instance is later created.
  await removeNavMember(orgId, "instance", instanceName);
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

/** Shallow-merge a patch into an instance's entity-kind-override config (the
 *  meta-side blob resolveInstance surfaces on req.instanceConfig). One atomic
 *  upsert — the merge happens IN Postgres (`config || patch`), so a concurrent
 *  writer (a user renaming the noun, another latch) can never be clobbered by
 *  a read-modify-write race. Backs platform().instances.patchDerivedConfig —
 *  the seam a module uses to latch a derived signal (inventory's
 *  `stock_latched`) meta-side. Cheap and idempotent. */
export async function patchInstanceDerivedConfig(
  orgId: string,
  moduleName: string,
  instanceName: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const targetId = `${moduleName}:${instanceName}`;
  const patchJson = JSON.stringify(patch);
  await meta
    .insertInto("entity_kind_overrides")
    .values({
      org_id: orgId,
      target_kind: "instance",
      target_id: targetId,
      display_label: null,
      display_label_plural: null,
      icon: null,
      hidden: false,
      nav_order: null,
      config: sql`${patchJson}::jsonb` as never,
    })
    .onConflict((c) =>
      c.columns(["org_id", "target_kind", "target_id"]).doUpdateSet({
        config: sql`coalesce(entity_kind_overrides.config, '{}'::jsonb) || ${patchJson}::jsonb` as never,
        updated_at: new Date(),
      }),
    )
    .execute();
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

// ─────────────────────── provisioning (the full birth) ─────────────
//
// Extracted from the POST /instances route body so the
// platform:create-instance action handler and the route share ONE
// implementation. The route's body was more than createInstance(): the
// module-enabled check, the workspace-wide name-collision check, and the
// presentation-override seed that gives the new instance its nav label and
// item noun. A caller that skipped the seed would create instances with no
// nav presence and a fallback noun — the UI-depth failure — so the whole
// birth lives here, once.

export type ProvisionInstanceResult =
  | { ok: true; instance: ModuleInstance }
  | {
      ok: false;
      code:
        | "module_not_enabled"
        | "instance_name_taken"
        | "invalid_slug"
        | "unknown_module"
        | "module_is_single_instance";
      message: string;
    };

export async function provisionInstance(args: {
  orgId: string;
  moduleName: string;
  instanceName: string;
  displayName: string;
}): Promise<ProvisionInstanceResult> {
  // Confirm the module is enabled for the workspace before creating an
  // instance of it.
  const enabled = await meta
    .selectFrom("org_modules")
    .select("module_name")
    .where("org_id", "=", args.orgId)
    .where("module_name", "=", args.moduleName)
    .executeTakeFirst();
  if (!enabled) {
    return {
      ok: false,
      code: "module_not_enabled",
      message: `Module '${args.moduleName}' isn't enabled for this workspace. Enable it first.`,
    };
  }
  // Confirm the instance_name doesn't collide with another instance
  // (workspace-unique across all modules).
  const collision = await getInstance(args.orgId, args.instanceName);
  if (collision) {
    return {
      ok: false,
      code: "instance_name_taken",
      message: `Instance name '${args.instanceName}' is already used by ${collision.module_name}.`,
    };
  }
  let created: ModuleInstance;
  try {
    created = await createInstance({
      orgId: args.orgId,
      moduleName: args.moduleName,
      instanceName: args.instanceName,
      displayName: args.displayName,
      isDefault: false,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "invalid_slug" || code === "unknown_module" || code === "module_is_single_instance") {
      return { ok: false, code, message: (err as Error).message };
    }
    throw err;
  }
  // Seed a presentation override row so the new instance shows up in the
  // nav with its display name AND carries its own item noun. The noun
  // defaults from the collection name ("Films" → "Film"/"Films"), so a
  // skinnable module's UI never has to fall back to its hardcoded word
  // ("part"). It's a default the user can fix in the instance settings —
  // see docs/design-decisions/one-record-substrate.md.
  const targetId = `${args.moduleName}:${args.instanceName}`;
  const itemNoun = singularize(args.displayName);
  // insertOnly protects a user's own rename, but it used to skip the whole row
  // when one already existed - so an instance whose override was created by
  // anything else (an icon, a nav position) never got a noun at all, and its
  // pages read the module's internal word forever. Fill the gap without
  // touching a word somebody already chose.
  const existing = await getOverrideConfig(args.orgId, "instance", targetId);
  const config = fillItemNounIfAbsent(existing, {
    itemNoun,
    itemNounPlural: pluralize(itemNoun),
  });
  await upsertOverride({
    orgId: args.orgId,
    targetKind: "instance",
    targetId,
    displayLabel: args.displayName,
    config,
    insertOnly: true,
  });
  // insertOnly leaves an EXISTING row alone entirely, so if the noun was the
  // thing missing, write it on its own.
  if (config !== existing) {
    await upsertOverride({ orgId: args.orgId, targetKind: "instance", targetId, config });
  }
  return { ok: true, instance: created };
}
