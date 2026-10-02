-- An offer Cobb makes is a record, and so is the conversation it sits in.
--
-- An offer (a change waiting for Confirm) lived only in the browser tab that
-- received it: the turn row that carried it is swept after a day, and the
-- conversation was kept in the tab's local storage. After a reload the owner
-- saw the plans' titles as plain text, with no card, no details and no
-- Confirm (2026-10-02). So each offer's full plan is kept here when it is
-- made, with whether it was answered and how, and the card renders from this
-- record; confirming runs the plan kept here, never a copy sent back by the
-- browser. A person's conversation is kept here too, so another tab or
-- another device shows the same one.
--
-- Additive; nothing reads these until the api that writes them is running.

create table if not exists core_ai_offers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  turn_id      uuid,
  summary      text not null default '',
  proposal     jsonb not null,
  -- open -> confirming -> confirmed | failed ; open -> cancelled | replaced
  status       text not null default 'open'
               check (status in ('open', 'confirming', 'confirmed', 'failed', 'cancelled', 'replaced')),
  outcome      jsonb,
  made_at      timestamptz not null default now(),
  answered_at  timestamptz
);
create index if not exists core_ai_offers_user_recent on core_ai_offers (user_id, made_at desc);

create table if not exists core_ai_conversations (
  user_id     uuid primary key,
  messages    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);
