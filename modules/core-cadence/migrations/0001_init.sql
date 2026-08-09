-- Consumption cadence — the event ledger (tenant-local).
--
-- One append-only row per quantity change, for ANY entity kind that declares a
-- quantity field. The ledger is the whole storage story: every derived signal
-- (rate, run-out, waste ratio, over-buy) is a pure function of these rows
-- (src/model.ts), so there is no state to keep in sync and a recompute is always
-- possible from history.
--
-- Tenant-local (no org_id — the tenant DB *is* the org, like
-- core_placement_placements) so it sits beside the entities it measures.
-- `user_id` is a bare uuid: users live in cobblr_meta, not this DB.
--
-- WHY event_type distinguishes consume from discard (see
-- docs/design-decisions/consumption-cadence.md): recording waste as consumption
-- inflates the learned rate and makes the system recommend buying MORE of the
-- thing you keep throwing away. They are different facts and must stay separate.
--
-- WHY context is on a purchase: a Costco run must not teach "48 rolls a week".
-- one_off contributes nothing to the rate, bulk is damped, faster pulls it up.

create table core_cadence_events (
  id            uuid primary key default gen_random_uuid(),

  -- The measured thing. Kind-agnostic on purpose: an inventory part, a groceries
  -- instance item, filament, medication — the engine reads field ROLES, never
  -- a hard-coded kind.
  entity_kind   text not null,
  entity_id     uuid not null,

  event_type    text not null check (event_type in ('purchase', 'consume', 'adjust', 'discard')),
  -- Signed, in the item's stored unit. Purchases positive, consume/discard negative.
  qty_delta     numeric not null,

  -- Purchase weighting only; ignored for other event types.
  context       text not null default 'normal'
                  check (context in ('normal', 'one_off', 'bulk', 'faster')),

  -- Where the fact came from, for provenance + debugging a surprising rate.
  source        text not null default 'manual'
                  check (source in ('scan', 'list', 'manual', 'wire', 'checkin')),

  -- Nullable: enables the spend/run-rate angle later without a second ledger.
  unit_price    numeric,

  -- WHEN IT HAPPENED (a receipt's date), not when we ingested it. The rate is
  -- computed from intervals between these, so backdating a receipt must move the
  -- cadence, and an import must not compress months of history into one day.
  occurred_at   timestamptz not null default now(),

  user_id       uuid,
  created_at    timestamptz not null default now()
);

-- The read path is always "this item's history, oldest first".
create index core_cadence_events_entity_idx
  on core_cadence_events (entity_kind, entity_id, occurred_at);

-- Sweeps that ask "what changed lately" across the workspace.
create index core_cadence_events_occurred_idx on core_cadence_events (occurred_at desc);

-- Signal debounce. The sweeper re-evaluates every item every tick, but a signal
-- is a NOTIFICATION: without this, "you're running low on milk" would land on the
-- shopping list every hour until you bought milk, which trains people to ignore
-- it. One row per (record, signal) remembers when we last said it, so the sweep
-- stays idempotent and quiet.
create table core_cadence_signals (
  entity_kind   text not null,
  entity_id     uuid not null,
  signal        text not null check (signal in ('reorder_due', 'buy_less')),
  last_emitted  timestamptz not null default now(),
  primary key (entity_kind, entity_id, signal)
);
