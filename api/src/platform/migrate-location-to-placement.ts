// HISTORICAL DATA MIGRATION — not kernel logic. Boot pass that (1) seeds the
// placement primitive (core_placement_placements, owned by core-placement) from
// every existing tenant-local `location_id`, and (2) installs the transitional
// sync TRIGGERS that keep placement in step with location_id going forward.
// DONE WHEN: the per-tenant core_placement_sync_drift sweep reads empty on
// prod + staging + dev for the soak window (no unconverted location_id
// writers remain), THEN step 4 drops location_id + these triggers + the
// drift table and deletes this file in that same change.
// Skip with `COBBLR_SKIP_HISTORICAL_MIGRATIONS=1`.
//
// Placement subsumes location_id (docs/design-decisions/placement-and-containment.md):
// "what is this thing inside of?" — a Location is just one KIND of container.
// The location-bearing tables each get one placement row per
// located entity: containee = the entity, container = the core-locations:location.
//
// Per org: ensure core-placement is enabled (creates the table); INSERT ...
// SELECT current location_id values into placement (`on conflict do nothing`,
// idempotent); then create-or-replace the sync function + triggers on each
// present located table. GUARANTEED complete for those orgs — every writer path
// fires the trigger, no app-code.
//
// Coverage note (transitional): this runs at boot for orgs that exist then. An
// org created (or a located module first enabled) AFTER a boot is un-triggered
// until the NEXT deploy's boot re-runs this (idempotent) — harmless while
// nothing reads placement yet (the backfill catches up the missed rows). A
// final pass precedes step 3's reader cutover so every org is covered.

import { meta } from "../db/meta.js";
import { getTenantPool, evictTenantPool } from "../db/tenant.js";
import { enableModuleForOrg } from "../modules/enable.js";

export interface PlacementBackfillResult {
  orgsTouched: number;
  rowsInserted: number;
}

// The location-bearing tenant tables and the entity-kind each maps to. Kinds are
// the BASE kinds; instances (3d-printers:item …) are a partition of the same
// row, so the base kind is the right containee_kind for the row's table.
const LOCATED_TABLES: Array<{ table: string; kind: string }> = [
  { table: "inventory_parts", kind: "inventory:part" },
  { table: "machines_machines", kind: "machines:machine" },
  { table: "assets_assets", kind: "assets:asset" },
  { table: "records_records", kind: "records:record" },
];

// The transitional sync: one plpgsql function that mirrors a row's location_id
// into core_placement_placements (a Location is one KIND of container). The
// kind is passed per-table as a trigger arg. The ONLY triggers in the codebase
// — deliberately scoped to this migration and removed at the location_id cutover
// (step 5). This is what makes the dual-write GUARANTEED complete: every writer
// path (handlers, actions, import, sync-writers) fires it, with zero app-code.
//
// DRIFT PROBE (placement-cutover-plan step 2): the seam (placement.place/
// remove) always writes the placement row BEFORE mirroring the column, so a
// trigger invocation that does REAL work — deleting a row the seam didn't
// already delete, or upserting where no matching row exists — is the signature
// of a direct location_id writer the campaign hasn't converted. Those land in
// core_placement_sync_drift; step 3/4 proceed when a sweep of that table reads
// empty across deployments for the soak window. The table drops with the
// triggers in step 4. NOTE for step 4: the DELETE branch below is the ONLY
// place entity-deletion placement cleanup happens today — it must move into
// the entity delete paths before the triggers go.
const TRIGGER_FUNCTION_SQL = `
create table if not exists core_placement_sync_drift (
  id bigserial primary key,
  tg_op text not null,
  containee_kind text not null,
  containee_id text not null,
  location_id text,
  occurred_at timestamptz not null default now()
);

create or replace function core_placement_sync_location() returns trigger
language plpgsql as $$
declare
  k text := TG_ARGV[0];
  drift_rows int := 0;
begin
  if TG_OP = 'DELETE' then
    -- Entity deleted: remove its OWN placement (whatever container kind — a
    -- lingering entity-container row would be a dangling ref), AND everything
    -- placed INSIDE it (it can't contain anything anymore). Expected work, not
    -- drift: deletion cleanup lives here by design until step 4 relocates it.
    delete from core_placement_placements
     where containee_kind = k and containee_id = OLD.id::text;
    delete from core_placement_placements
     where container_kind = k and container_id = OLD.id::text;
    return OLD;
  end if;
  if NEW.location_id is null then
    -- location cleared: drop the location-derived placement (leave any
    -- non-location placement alone).
    delete from core_placement_placements
     where containee_kind = k and containee_id = NEW.id::text
       and container_kind = 'core-locations:location';
    get diagnostics drift_rows = row_count;
    if drift_rows > 0 then
      -- The seam removes the placement before clearing the column; finding a
      -- row to delete here means a direct writer cleared location_id.
      insert into core_placement_sync_drift (tg_op, containee_kind, containee_id, location_id)
      values (TG_OP, k, NEW.id::text, null);
    end if;
  else
    if not exists (
      select 1 from core_placement_placements
       where containee_kind = k and containee_id = NEW.id::text
         and (container_kind <> 'core-locations:location'
              or container_id = NEW.location_id::text)
    ) then
      -- No matching location-derived row and no entity-container placement
      -- (which the guard below deliberately leaves alone): the upsert below is
      -- about to do real work, so a direct writer set location_id.
      insert into core_placement_sync_drift (tg_op, containee_kind, containee_id, location_id)
      values (TG_OP, k, NEW.id::text, NEW.location_id::text);
    end if;
    insert into core_placement_placements
      (containee_kind, containee_id, container_kind, container_id)
    values (k, NEW.id::text, 'core-locations:location', NEW.location_id::text)
    on conflict (containee_kind, containee_id) do update
      set container_kind = 'core-locations:location',
          container_id   = excluded.container_id,
          placed_at      = now()
      -- Guard: an ENTITY-container placement (a part deliberately placed inside
      -- a machine/server via the Contents panel or scan-into-container) is NOT
      -- clobbered by an incidental location edit. Locations only overwrite
      -- location-derived placements; leaving a container is an explicit
      -- remove/move, not a side effect. (Without this, editing a contained
      -- part's location field silently yanked it out of its container.)
      where core_placement_placements.container_kind = 'core-locations:location';
  end if;
  return NEW;
end;
$$;
`;

// Advisory-lock key that serialises the placement-sync DDL WITHIN a tenant DB.
// Advisory locks are scoped to the database they're taken in, and every tenant
// is its own DB, so this single constant never cross-contends between orgs — it
// only serialises concurrent installers racing on the SAME tenant (see
// backfillOne). Any stable bigint works; this one is arbitrary + namespaced by
// comment.
const PLACEMENT_SYNC_DDL_LOCK = 0x504c4143n; // "PLAC"

// Per located table: ins/del fire always; update fires only when location_id
// actually changes (so unrelated updates don't churn placed_at). Idempotent —
// drop-if-exists + create. Table/kind are hardcoded constants, not user input.
function triggerSql(table: string, kind: string): string {
  return `
drop trigger if exists ${table}_placement_sync on ${table};
create trigger ${table}_placement_sync
  after insert or delete on ${table}
  for each row execute function core_placement_sync_location('${kind}');
drop trigger if exists ${table}_placement_sync_upd on ${table};
create trigger ${table}_placement_sync_upd
  after update on ${table}
  for each row when (old.location_id is distinct from new.location_id)
  execute function core_placement_sync_location('${kind}');
`;
}

async function backfillOne(orgId: string): Promise<{ rowsInserted: number }> {
  const pool = await getTenantPool(orgId);

  // Which of the located tables actually exist in this tenant DB? (An org that
  // never enabled inventory/machines/assets won't have all three.)
  const present: Array<{ table: string; kind: string }> = [];
  for (const t of LOCATED_TABLES) {
    const { rows } = await pool.query<{ exists: boolean }>(
      `select to_regclass('public.${t.table}') is not null as exists`,
    );
    if (rows[0]?.exists) present.push(t);
  }
  if (present.length === 0) return { rowsInserted: 0 };

  // Ensure the placement table exists (core-placement is foundational/autoEnable,
  // but enableModuleForOrg is idempotent and runs the migration if it hasn't).
  await enableModuleForOrg(orgId, "core-placement");

  let rowsInserted = 0;
  for (const t of present) {
    // One INSERT ... SELECT per table: each located entity → a placement row
    // whose container is its core-locations:location. Idempotent on the
    // one-container-per-containee unique key.
    const result = await pool.query(
      `insert into core_placement_placements
         (containee_kind, containee_id, container_kind, container_id)
       select $1, id, 'core-locations:location', location_id
         from ${t.table}
        where location_id is not null
       on conflict (containee_kind, containee_id) do nothing`,
      [t.kind],
    );
    rowsInserted += result.rowCount ?? 0;
  }

  // Install the sync triggers so placement stays in step with location_id going
  // forward (the backfill above only seeds the current state). One function +
  // two triggers per present table; idempotent, so a re-run refreshes them.
  //
  // SERIALISED behind a transaction-scoped advisory lock: `enableModuleForOrg`
  // is called CONCURRENTLY for one fresh org (the test harness's
  // enableAllModulesForTests fires ~29 `/enable` calls in capped-concurrency
  // waves against the SAME org), so two located modules (inventory + machines +
  // assets) can reach HERE at the same time on the SAME tenant DB. Bare
  // concurrent `CREATE OR REPLACE FUNCTION` on one catalog object
  // races → Postgres raises `tuple concurrently updated`, and the enable-time
  // caller (ensurePlacementSyncIfLocated) SWALLOWS it — silently leaving the org
  // WITHOUT the location_id→placement trigger. A part created afterwards then
  // gets no placement row and `/of` reads back null: the intermittent
  // placement-semantics flake. The advisory lock makes concurrent installers
  // serialise instead of collide; the DDL is idempotent, so the second one
  // through re-applies cleanly. Now the trigger is GUARANTEED present by the time
  // the (awaited) enable/checkout returns — placement is coherent on the very
  // next write, no read-back race.
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [PLACEMENT_SYNC_DDL_LOCK.toString()]);
    await client.query(TRIGGER_FUNCTION_SQL);
    for (const t of present) {
      await client.query(triggerSql(t.table, t.kind));
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { rowsInserted };
}

/** Ensure the placement backfill + sync triggers exist for ONE org. The boot
 *  pass covers orgs that existed at boot; this covers orgs created AFTER it
 *  (fresh signups) — called from enableModuleForOrg when a located module
 *  (inventory/machines/assets) is enabled, so a new workspace is triggered
 *  immediately instead of waiting for the next deploy's boot. Idempotent. */
export async function ensurePlacementSyncForOrg(orgId: string): Promise<void> {
  // Deliberately NOT gated on COBBLR_SKIP_HISTORICAL_MIGRATIONS — that flag
  // skips the expensive all-orgs BOOT sweep; this per-org call is a few cheap
  // queries and correctness-bearing (without it a new org's placement silently
  // drifts from location_id — exactly what CI's skip-flag exposed).
  await backfillOne(orgId);
}

/** Boot-time entry point. Backfills placement from location_id for every org
 *  that has a location-bearing module enabled. */
export async function backfillPlacements(): Promise<PlacementBackfillResult> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") {
    return { orgsTouched: 0, rowsInserted: 0 };
  }
  const orgs = await meta
    .selectFrom("org_modules")
    .select("org_id")
    .where("module_name", "in", ["inventory", "machines", "assets"])
    .distinct()
    .execute();

  let orgsTouched = 0;
  let rowsInserted = 0;
  for (const o of orgs) {
    try {
      const r = await backfillOne(o.org_id);
      if (r.rowsInserted > 0) orgsTouched++;
      rowsInserted += r.rowsInserted;
    } catch (err) {
      console.error(
        `[backfill-placements] org ${o.org_id} failed:`,
        (err as Error).message,
      );
    } finally {
      // Release the tenant pool immediately — this boot pass is serial and
      // pre-`listen`; leaving every org's pool cached open exhausts Postgres
      // max_connections. Reopens lazily on first request.
      await evictTenantPool(o.org_id);
    }
  }
  return { orgsTouched, rowsInserted };
}
