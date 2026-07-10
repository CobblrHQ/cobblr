-- Ask Cobb per-user tool consent. Since the agent loop, the chat AUTO-READS
-- workspace records into prompts (and, with a shared AI, that data transits
-- another member's connection) — so reading is a consent the user can withdraw,
-- and proposing writes is a mode they can turn off. One row per user in this
-- workspace; absent row = both on (the defaults). Enforced server-side in
-- chat.ts (tool defs filtered + prompt adjusted), not just hidden in the UI.
create table if not exists core_ai_chat_prefs (
  user_id     uuid primary key,
  read_tools  boolean not null default true,
  write_tools boolean not null default true,
  updated_at  timestamptz not null default now()
);
