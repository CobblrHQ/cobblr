-- Quantity-driven PRODUCTION RUNS on top of pools ("make 250 of these, stop
-- when done") — the workflow gap the print-farm-manager review exposed
-- (docs/modules/digifab-farm-feature-map.md, the PFM row).
--
-- A run = pool + library file + target_qty + parts_per_plate. The assign
-- worker MINTS queued pool jobs to the over-dispatch ceiling
-- (ceil((target - completed) / ppp), counting jobs already in flight), the
-- existing drip/bed-clear/retry machinery runs them, and the HUMAN bed-clear
-- verdict is what increments completed_qty (good counts, scrapped doesn't —
-- stricter than PFM's mere-completion). At target the run closes and its
-- still-queued jobs are cancelled.

create table digifab_production_runs (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  pool_id          uuid not null references digifab_pools(id) on delete cascade,
  -- The plate file: a core-files id (bytes uploaded at send) + display name.
  file_id          text,
  file_ref         text not null,
  parts_per_plate  int not null default 1,
  target_qty       int not null,
  completed_qty    int not null default 0,
  -- active | paused | completed | cancelled
  status           text not null default 'active',
  -- Defaults stamped onto every minted job (same semantics as on digifab_jobs).
  material_part_id text,
  material_grams   numeric,
  linked_build_id  text,
  build_qty        int not null default 1,
  priority         int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Minted jobs point back at their run. ON DELETE SET NULL: deleting a run
-- orphans (not kills) an in-flight print — coordinate-not-control.
alter table digifab_jobs add column run_id uuid references digifab_production_runs(id) on delete set null;

-- The verdict-aware ceiling flag. A job that reached `completed` still COVERS
-- its run until the human verdict lands (else the worker would mint a premature
-- replacement for a plate that's about to be counted):
--   null      → pending (non-terminal, or completed-awaiting-verdict)
--   'counted' → good verdict; completed_qty was incremented
--   'scrapped'→ scrapped verdict; does NOT cover — a replacement gets minted
alter table digifab_jobs add column run_outcome text;

create index digifab_jobs_run_idx on digifab_jobs(run_id, status);
create index digifab_runs_status_idx on digifab_production_runs(status);

-- manual recovery if this fails partway (module migrations are file-tracked):
--   ALTER TABLE digifab_jobs DROP COLUMN IF EXISTS run_outcome;
--   ALTER TABLE digifab_jobs DROP COLUMN IF EXISTS run_id;
--   DROP TABLE IF EXISTS digifab_production_runs;
