// HISTORICAL DATA MIGRATION — not kernel logic.
// DONE WHEN: `scripts/base-kind-twins.sh` reports workspaces_with_twin_defs: 0
// for cobblr.flagship.groceries on prod + staging + dev consistently (the boot
// pass reports orgsTouched=0); then delete this file, its boot call and its
// test-support trigger.
//
// The Groceries bundle carried a second copy of its food fields on the BASE
// kind inventory:part (shelf life, expiry, bought-on, storage, food category),
// kept "for workspaces whose food still lived in plain Inventory" before
// instances existed. A specialisation is an INSTANCE, not a lens on the base
// (specialisations-are-instances), and the twin cost twice: a check-off
// restocked twice while a wire lived at both scopes (#2787), and the twin's
// `expiry` role made every inventory instance in the workspace perishable
// (#2849). #2860 asks the twin to go, and counted who depends on it: on prod,
// one workspace, three food rows in plain Inventory.
//
// So, per install, in this order:
//   TENANT first, so nothing loses its labels:
//     1. rows in the DEFAULT inventory instance that carry any twin field move
//        to the `groceries` instance (created through createInstance if an old
//        install lacks it), each announced in the workspace's activity log as
//        moved by the upgrade, so the owner sees why a row changed collection.
//   META:
//     2. the twin defs (module_field_defs on inventory:part under this bundle)
//        go: one the instance already has by name is deleted, one it lacks
//        is re-keyed to groceries:item (an install from before instances
//        existed, 0.1.x on staging, has no instance copy at all, and deleting
//        would strip the labels off the rows that just moved);
//     3. the stored manifest's top-level field_defs become [], carried under
//        a provides_instances entry when the old manifest had none, so an
//        update or a reinstall does not plant them again, and its version is
//        stamped past the shipped one so the dashboard stops offering an
//        "update" for a shape the bundle no longer has.
//
// "Is food" = what the bundle itself said food carries: any of ITS twin fields
// filled. `food_category` alone qualifies (a row with a food category is food
// whatever else is blank); so does any of the others. A row with none is
// somebody's screws and stays exactly where it is (the Bookshelf rule):
// stranding a food row on /inventory is a cosmetic miss the owner can fix,
// dragging a real part into Groceries is data damage.
//
// Idempotent: an install with no twin defs left is skipped before any tenant
// pool opens; the row move filters on the OLD instance; the manifest rewrite
// is a no-op once field_defs is empty. Skip with
// COBBLR_SKIP_HISTORICAL_MIGRATIONS=1. Per-org try/catch, pools evicted.
//
// RUNS IN THE API PROCESS ONLY (createInstance needs the module registry);
// its integration test drives it through the test-support trigger.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, evictTenantPool } from "../db/tenant.js";
import { createInstance, getInstance } from "./instances.js";
import { upsertOverride } from "./entity-kind-overrides.js";
import { log as activityLog } from "./activity.js";

export const GROCERIES_EXTERNAL_ID = "cobblr.flagship.groceries";
const BASE_KIND = "inventory:part";
const INSTANCE_NAME = "groceries";
const DISPLAY_NAME = "Groceries";
const INSTANCE_KIND = `${INSTANCE_NAME}:item`;
const GLYPH = "\u{1F96C}";
const ITEM_NOUN = "item";
const QTY_UNIT = "unit";
/** The version the stored manifest is stamped with once its twin is gone:
 *  past the shipped one so an "update available" is not offered for a shape
 *  the bundle no longer has. */
export const RETIRED_TWIN_VERSION = "0.11.0";

interface StoredManifest {
  version?: string;
  field_defs?: Array<{ entity_kind?: string; name: string; [k: string]: unknown }>;
  provides_instances?: unknown[];
  [k: string]: unknown;
}

function parseManifest(raw: unknown): StoredManifest | null {
  if (!raw) return null;
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as StoredManifest;
  } catch {
    return null;
  }
}

/** Retire one install's twin. Returns what it did. */
async function retireOne(
  orgId: string,
  bundleId: string,
  twinFields: string[],
  manifest: StoredManifest | null,
): Promise<{ rowsMoved: number; defsDropped: number }> {
  // TENANT: the food rows first.
  let rowsMoved = 0;
  if (twinFields.length > 0) {
    if (!(await getInstance(orgId, INSTANCE_NAME))) {
      await createInstance({
        orgId,
        moduleName: "inventory",
        instanceName: INSTANCE_NAME,
        displayName: DISPLAY_NAME,
        isDefault: false,
      });
      // The face a Groceries table wears at install: label, glyph, nouns.
      await upsertOverride({
        orgId,
        targetKind: "instance",
        targetId: `inventory:${INSTANCE_NAME}`,
        displayLabel: DISPLAY_NAME,
        icon: GLYPH,
        config: { item_noun: ITEM_NOUN, qty_unit: QTY_UNIT, parent: null },
        insertOnly: true,
      });
    }
    const tdb = await getTenantDb(orgId);
    const filled = sql.join(
      twinFields.map((n) => sql`((metadata ->> ${n}) is not null and (metadata ->> ${n}) <> '')`),
      sql` or `,
    );
    const moved = await sql<{ id: string; name: string }>`
      update inventory_parts
         set instance = ${INSTANCE_NAME}, updated_at = now()
       where instance = 'inventory' and (${filled})
      returning id, name
    `.execute(tdb);
    rowsMoved = moved.rows.length;
    for (const r of moved.rows) {
      await activityLog({
        orgId,
        userId: null,
        action: "moved_by_upgrade",
        ref: { module: "inventory", entityType: "part", entityId: r.id },
        diff: {
          from_instance: "inventory",
          to_instance: INSTANCE_NAME,
          name: r.name,
          note: "moved from Inventory to Groceries by the upgrade: its food fields belong to the Groceries table",
        },
      });
    }
  }

  // META: the twin defs go. One the instance already carries by name is
  // deleted; one it lacks is re-keyed to the instance so the rows that just
  // moved keep their labels.
  const onInstance = new Set(
    (
      await meta
        .selectFrom("module_field_defs")
        .select("name")
        .where("org_id", "=", orgId)
        .where("entity_kind", "=", INSTANCE_KIND)
        .execute()
    ).map((d) => d.name),
  );
  const twinRows = await meta
    .selectFrom("module_field_defs")
    .select(["id", "name"])
    .where("org_id", "=", orgId)
    .where("bundle_id", "=", bundleId)
    .where("entity_kind", "=", BASE_KIND)
    .execute();
  const toDelete = twinRows.filter((d) => onInstance.has(d.name)).map((d) => d.id);
  const toRekey = twinRows.filter((d) => !onInstance.has(d.name)).map((d) => d.id);
  if (toDelete.length) await meta.deleteFrom("module_field_defs").where("id", "in", toDelete).execute();
  if (toRekey.length) await meta.updateTable("module_field_defs").set({ entity_kind: INSTANCE_KIND }).where("id", "in", toRekey).execute();

  if (manifest && Array.isArray(manifest.field_defs) && manifest.field_defs.length > 0) {
    const next: StoredManifest = { ...manifest, field_defs: [], version: RETIRED_TWIN_VERSION };
    if (!(Array.isArray(manifest.provides_instances) && manifest.provides_instances.length > 0)) {
      next.provides_instances = [
        {
          module: "inventory",
          instance_name: INSTANCE_NAME,
          display_name: DISPLAY_NAME,
          glyph: GLYPH,
          item_noun: ITEM_NOUN,
          qty_unit: QTY_UNIT,
          field_defs: manifest.field_defs.map((f) => ({ ...f, entity_kind: INSTANCE_KIND })),
        },
      ];
    }
    await meta
      .updateTable("bundles")
      .set({ manifest: sql`${JSON.stringify(next)}::jsonb` as never, version: RETIRED_TWIN_VERSION })
      .where("id", "=", bundleId)
      .execute();
  }
  return { rowsMoved, defsDropped: twinRows.length };
}

/** Boot-time entry point. Cheap on the happy path: one indexed meta read, and
 *  no tenant pool is opened unless a workspace still carries the twin. */
export async function retireGroceriesBaseKindTwin(opts?: { force?: boolean }): Promise<{
  orgsTouched: number;
  rowsMoved: number;
  defsDropped: number;
}> {
  if (!opts?.force && process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") {
    return { orgsTouched: 0, rowsMoved: 0, defsDropped: 0 };
  }
  const installs = await meta
    .selectFrom("bundles")
    .select(["id", "org_id", "manifest"])
    .where("external_id", "=", GROCERIES_EXTERNAL_ID)
    .execute();
  if (installs.length === 0) return { orgsTouched: 0, rowsMoved: 0, defsDropped: 0 };
  const twins = await meta
    .selectFrom("module_field_defs")
    .select(["org_id", "bundle_id", "name"])
    .where("entity_kind", "=", BASE_KIND)
    .where("bundle_id", "in", installs.map((i) => i.id))
    .execute();
  const twinByBundle = new Map<string, string[]>();
  for (const t of twins) {
    if (!t.bundle_id) continue;
    twinByBundle.set(t.bundle_id, [...(twinByBundle.get(t.bundle_id) ?? []), t.name]);
  }

  let orgsTouched = 0;
  let rowsMoved = 0;
  let defsDropped = 0;
  for (const inst of installs) {
    const twinFields = twinByBundle.get(inst.id) ?? [];
    if (twinFields.length === 0) continue;
    try {
      const out = await retireOne(inst.org_id, inst.id, twinFields, parseManifest(inst.manifest));
      orgsTouched += 1;
      rowsMoved += out.rowsMoved;
      defsDropped += out.defsDropped;
      console.log(
        `[retire-groceries-twin] org ${inst.org_id}: ${out.rowsMoved} food row(s) moved into Groceries, ${out.defsDropped} base-kind field(s) dropped`,
      );
    } catch (err) {
      console.error(`[retire-groceries-twin] org ${inst.org_id} failed:`, (err as Error).message);
    } finally {
      evictTenantPool(inst.org_id);
    }
  }
  return { orgsTouched, rowsMoved, defsDropped };
}
