-- The AI change ledger + the tri-state write mode.
--
-- LEDGER: every write Ask Cobb executes (user-confirmed OR auto-applied)
-- records what happened WITH a before-image, so undo is mechanical:
-- create → delete, update → restore the before fields, delete → recreate from
-- the image. An undo is itself a ledger row (undo_of) — undoing an undo works.
-- Actions are recorded too but are not undoable (arbitrary side effects).
--
-- MODE: 'Propose changes' grows a third state, Claude-Code style:
--   off  → no write proposals at all
--   ask  → every write is a proposal the user confirms (the default)
--   auto → record creates/updates/deletes APPLY IMMEDIATELY (ledgered, undoable);
--          ACTIONS still ask — they can be irreversible (print, adjust stock).
-- write_tools stays for back-compat reads; write_mode is the source of truth.

create table if not exists core_ai_chat_writes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  tool         text not null check (tool in ('create','update','delete','action')),
  entity_kind  text not null,
  entity_id    text,
  entity_label text not null default '',
  -- Full record image before the write (null for create); the undo source.
  before       jsonb,
  -- What the write set/produced (fields for create/update; args for action).
  payload      jsonb,
  auto_applied boolean not null default false,
  undone_at    timestamptz,
  undo_of      uuid references core_ai_chat_writes(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists core_ai_chat_writes_recent
  on core_ai_chat_writes (created_at desc);

alter table core_ai_chat_prefs
  add column if not exists write_mode text not null default 'ask'
    check (write_mode in ('off','ask','auto'));
-- Backfill from the boolean era: write_tools=false meant "no proposals".
update core_ai_chat_prefs set write_mode = 'off' where write_tools = false;
