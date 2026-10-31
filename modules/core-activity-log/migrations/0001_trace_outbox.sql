-- Every change leaves its trace. A record lives in the workspace's database
-- and its History line in the server's, so the line is a second write that a
-- refused connection or a process dying between the two can lose.
--
-- core_activity_log_pending: a line the server's database refused, kept here
-- (beside the change it records) until a round sends it.
-- core_activity_log_intents: written before a change is made through a
-- record's writer and removed once its line has landed. One still here after
-- its write is long over means the line never landed; a round reads the
-- record and writes the line from what it was to what it is.
create table if not exists core_activity_log_pending (
  id          uuid primary key,
  line        jsonb not null,
  created_at  timestamptz not null default now(),
  attempts    integer not null default 0,
  last_error  text
);

create table if not exists core_activity_log_intents (
  id          uuid primary key,
  kind        text not null,
  entity_id   text not null,
  before      jsonb not null,
  who         jsonb not null,
  force_log   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists core_activity_log_intents_age_idx on core_activity_log_intents (created_at);
