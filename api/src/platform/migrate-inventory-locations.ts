// HISTORICAL DATA MIGRATION — not kernel logic. The hardcoded
// `inventory` / `core-locations` names + the legacy table shape
// here are encoded migration knowledge, not steady-state coupling.
// Delete once every production tenant has been migrated. Skip
// with `COBBLR_SKIP_HISTORICAL_MIGRATIONS=1`.
//
// One-shot boot migration: inventory_locations → core_locations_locations.
//
// Locations used to live under the inventory module (`inventory:location`,
// table `inventory_locations`) but conceptually they're cross-module — every
// module with physical entities (machines, assets, inventory parts, future
// kinds) wants a location_id reference. The new `core-locations` foundational
// module owns the canonical table now.
//
// What this migration does, per org:
//   1. If `inventory_locations` exists in the tenant DB AND the org doesn't
//      already have core-locations enabled, enable core-locations (creates
//      core_locations_locations table via the module's own migration).
//   2. Copy every row from inventory_locations → core_locations_locations
//      preserving UUIDs. Existing location_id refs on machines.location_id,
//      assets.location_id, inventory_parts.location_id all stay valid.
//   3. Drop the FK constraint on inventory_parts.location_id → inventory_
//      locations(id). The column becomes a plain UUID. inventory_locations
//      table is left around (dead data) for safety — a future cleanup
//      migration can drop it.
//
// Idempotent: if the copy already happened (every inventory_locations row
// already present in core_locations_locations), the per-org step no-ops.
// Safe to re-run on every boot until all affected orgs are migrated.

import { meta } from "../db/meta.js";
import { getTenantPool } from "../db/tenant.js";
import { enableModuleForOrg } from "../modules/enable.js";

export interface InventoryLocationsMigrationResult {
  orgsTouched: number;
  rowsCopied: number;
  fksDropped: number;
}

interface InventoryLocationRow {
  id: string;
  name: string;
  short_name: string | null;
  parent_id: string | null;
  depth: number;
  kind: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

async function migrateOne(orgId: string): Promise<{
  rowsCopied: number;
  fkDropped: boolean;
}> {
  const pool = await getTenantPool(orgId);

  // Does this tenant even have the legacy table? (orgs that never
  // enabled inventory won't.) If not, nothing to do.
  const { rows: legacyRows } = await pool.query<{ exists: boolean }>(
    `select to_regclass('public.inventory_locations') is not null as exists`,
  );
  if (!legacyRows[0]?.exists) {
    return { rowsCopied: 0, fkDropped: false };
  }

  // Ensure core-locations is enabled for this org. enableModuleForOrg
  // is idempotent (returns alreadyEnabled=true on the second call), and
  // it'll run the module's migration to create core_locations_locations.
  await enableModuleForOrg(orgId, "core-locations");

  // Source rows.
  const { rows: src } = await pool.query<InventoryLocationRow>(
    `select id, name, short_name, parent_id, depth, kind, metadata,
            created_at, updated_at
       from inventory_locations`,
  );
  let rowsCopied = 0;
  if (src.length > 0) {
    // Two-pass insert: roots first (parent_id null), then by depth
    // ascending so each insert's parent already exists. The FK self-ref
    // in core_locations_locations requires this.
    const byDepth = new Map<number, InventoryLocationRow[]>();
    for (const r of src) {
      const list = byDepth.get(r.depth) ?? [];
      list.push(r);
      byDepth.set(r.depth, list);
    }
    const depthsAsc = Array.from(byDepth.keys()).sort((a, b) => a - b);
    for (const d of depthsAsc) {
      for (const r of byDepth.get(d)!) {
        const result = await pool.query(
          `insert into core_locations_locations
             (id, name, short_name, parent_id, depth, kind,
              metadata, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (id) do nothing`,
          [
            r.id,
            r.name,
            r.short_name,
            r.parent_id,
            r.depth,
            r.kind,
            r.metadata ?? {},
            r.created_at,
            r.updated_at,
          ],
        );
        if (result.rowCount && result.rowCount > 0) rowsCopied++;
      }
    }
  }

  // Drop the FK constraint on inventory_parts.location_id → inventory_
  // locations(id) if it's still there. Postgres auto-names the constraint
  // `inventory_parts_location_id_fkey`; we look it up rather than
  // hard-coding so a re-run on a previously-fixed DB no-ops cleanly.
  let fkDropped = false;
  const { rows: fkRows } = await pool.query<{ constraint_name: string }>(
    `select tc.constraint_name
       from information_schema.table_constraints tc
       join information_schema.referential_constraints rc
         on rc.constraint_name = tc.constraint_name
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = rc.unique_constraint_name
      where tc.table_name = 'inventory_parts'
        and tc.constraint_type = 'FOREIGN KEY'
        and ccu.table_name = 'inventory_locations'`,
  );
  for (const row of fkRows) {
    await pool.query(
      `alter table inventory_parts drop constraint "${row.constraint_name}"`,
    );
    fkDropped = true;
  }

  return { rowsCopied, fkDropped };
}

/** Boot-time entry point. Finds every org and runs the per-org copy. */
export async function migrateInventoryLocations(): Promise<InventoryLocationsMigrationResult> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") {
    return { orgsTouched: 0, rowsCopied: 0, fksDropped: 0 };
  }
  // We need orgs that have inventory enabled (their tenant DB has the
  // legacy table). enableModuleForOrg for core-locations is idempotent
  // for orgs that don't.
  const orgs = await meta
    .selectFrom("org_modules")
    .select("org_id")
    .where("module_name", "=", "inventory")
    .distinct()
    .execute();

  let orgsTouched = 0;
  let rowsCopied = 0;
  let fksDropped = 0;
  for (const o of orgs) {
    try {
      const r = await migrateOne(o.org_id);
      if (r.rowsCopied > 0 || r.fkDropped) orgsTouched++;
      rowsCopied += r.rowsCopied;
      if (r.fkDropped) fksDropped++;
    } catch (err) {
      console.error(
        `[migrate-inventory-locations] org ${o.org_id} failed:`,
        (err as Error).message,
      );
    }
  }
  return { orgsTouched, rowsCopied, fksDropped };
}
