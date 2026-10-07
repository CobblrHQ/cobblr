-- A planning layout for one place (a room): what would move where, kept
-- apart from the real records until somebody applies it. `body` holds the
-- draft's moves, the things it puts somewhere and the racks it plans; when
-- it is applied, `applied` keeps what the apply did, which is everything its
-- undo needs. Additive: a new table nothing else reads.
--
-- manual recovery if this fails partway:
--   DROP TABLE core_locations_plan_drafts;
create table core_locations_plan_drafts (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references core_locations_locations(id) on delete cascade,
  name         text not null,
  body         jsonb not null default '{}'::jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  applied_at   timestamptz,
  applied      jsonb
);
create index core_locations_plan_drafts_location on core_locations_plan_drafts (location_id);
