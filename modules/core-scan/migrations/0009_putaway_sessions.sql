-- Put-away sessions (docs/product/put-away.md §2.2): ONE resumable execution
-- engine under both tempos. mode='plan' = the Guided Organize walk (queue
-- seeded from an applied plan; replaces walk_state on the plan row — that
-- column stays for in-flight walks and is imported on first start, then
-- unused). mode='live' = Live Sort (open-ended; each scan is routed to a
-- directive at scan time). Rows are ephemeral working state like plans:
-- expired sessions are deleted opportunistically.
create table core_scan_putaway_sessions (
  id                      uuid primary key default gen_random_uuid(),
  mode                    text not null check (mode in ('plan', 'live')),
  plan_id                 uuid,          -- plan mode: the organize plan it executes
  catch_all_location_id   uuid,          -- live mode: the designated "Unsorted" bin
  -- mode-specific working state:
  --   plan: { placed_item_ids: string[] }
  --   live: { entries: [...], sticky: {...} }
  state                   jsonb not null default '{}'::jsonb,
  created_by_user_id      uuid,
  created_at              timestamptz not null default now(),
  ended_at                timestamptz,
  expires_at              timestamptz not null
);
create index core_scan_putaway_sessions_active
  on core_scan_putaway_sessions (created_at desc)
  where ended_at is null;
