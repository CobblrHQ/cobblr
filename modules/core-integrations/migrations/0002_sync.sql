-- core-integrations — data-sync connectors (the SYNC half).
--
-- A sync connector mirrors records from an external system (e.g. Workshop
-- OS locations) into a Cobblr entity kind. Two paths converge on ONE
-- idempotent upsert keyed by (connection, external_id):
--   • webhook (live)   — the source POSTs on change → upsert that record.
--   • reconcile poll   — periodic full pull → upsert + delete-detect.
--
-- Per-workspace tables:
--   synced_records  — the id-map (external_id ↔ mirrored cobblr entity).
--                     Upserts key off this; it also resolves parent
--                     hierarchy and detects deletes (tombstones).
--   sync_state      — per (connection, entity_type) enablement + cadence
--                     + last-run status, for the UI and the poll worker.

-- One mirrored record per (connection, entity_type, external_id).
create table core_integrations_synced_records (
  id               uuid primary key default gen_random_uuid(),
  connector_row_id uuid not null
                   references core_integrations_connectors(id) on delete cascade,
  entity_type      text not null,            -- connector's type key, e.g. "locations"
  target_kind      text not null,            -- cobblr kind, e.g. "core-locations:location"
  external_id      text not null,            -- the source system's stable id
  cobblr_entity_id text not null,            -- the mirrored cobblr entity id
  source_hash      text,                     -- hash of last-synced fields (skip no-op updates)
  deleted_at       timestamptz,              -- tombstone: source row vanished
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (connector_row_id, entity_type, external_id)
);

create index core_integrations_synced_records_lookup_idx
  on core_integrations_synced_records(connector_row_id, entity_type);

-- Per (connection, entity_type) sync config + last-run status.
create table core_integrations_sync_state (
  connector_row_id  uuid not null
                    references core_integrations_connectors(id) on delete cascade,
  entity_type       text not null,
  enabled           boolean not null default false,
  cadence_min       integer not null default 20,   -- reconcile poll interval (minutes)
  last_run_at       timestamptz,
  last_status       text,                           -- "ok" / "error"
  last_error        text,
  last_synced_count integer,
  next_run_at       timestamptz,                    -- the poll worker's due-time
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (connector_row_id, entity_type)
);

-- The poll worker scans for due, enabled syncs.
create index core_integrations_sync_state_due_idx
  on core_integrations_sync_state(next_run_at) where enabled;
