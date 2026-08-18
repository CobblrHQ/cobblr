-- A chat TURN is a persisted, addressable thing.
--
-- Until now a turn was one HTTP request held open for as long as the model
-- and its tool calls took (30-150s). That shape produced three complaints at
-- once, and they are the same defect:
--   * nothing shows while it runs, so the widget looks dead until the answer
--     lands in one piece;
--   * a page refresh drops the request, and the turn with it - the work keeps
--     running server-side but no one is listening for the answer;
--   * two tabs of the same workspace cannot show each other's in-progress turn,
--     because the only record of it is a promise inside one browser tab.
--
-- So: POST creates a turn row and returns its id at once; the loop runs
-- detached and appends events here as it goes; a subscriber streams the
-- events (replaying history first). Every tab, refresh and re-open subscribes
-- to the same turn. Nothing about the turn lives in a socket any more.
--
-- Rows are per-user (a chat is private to the person having it) and short
-- lived: the sweeper removes finished turns after a day.

create table if not exists core_ai_chat_turns (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  -- The user message that started this turn, so a reconnecting tab can render
  -- it before any event arrives.
  prompt       text not null,
  -- queued -> running -> done | failed
  status       text not null default 'queued'
               check (status in ('queued','running','done','failed')),
  -- The final response the old blocking POST used to return, once done.
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists core_ai_chat_turns_user_recent
  on core_ai_chat_turns (user_id, created_at desc);

-- One row per progress event. seq is dense per turn so a subscriber can say
-- "give me everything after N" and miss nothing across a reconnect.
create table if not exists core_ai_chat_turn_events (
  turn_id     uuid not null references core_ai_chat_turns(id) on delete cascade,
  seq         integer not null,
  -- thinking | tool | tool-result | applied | text | done | error
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  primary key (turn_id, seq)
);
