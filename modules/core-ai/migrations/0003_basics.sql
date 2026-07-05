-- Ask Cobblr "basic mode", per workspace (Phase 2 of the trainable no-AI chat;
-- docs/design-decisions/no-ai-chat-training.md). Built-in rules live in code
-- (basics-catalog.ts); this table holds only what a workspace CHANGES:
--   • builtin_key NOT NULL → an override of that built-in (reply / keywords /
--     enabled / position / intent). At most one per built-in key.
--   • builtin_key NULL     → a net-new custom rule.
-- The effective ruleset = built-ins overlaid with overrides, then customs.

create table core_ai_basics (
  id           uuid primary key default gen_random_uuid(),
  builtin_key  text,
  intent       text not null,
  keywords     jsonb not null default '[]',
  reply        text not null,
  enabled      boolean not null default true,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- At most one override row per built-in.
create unique index core_ai_basics_builtin_key_idx
  on core_ai_basics (builtin_key) where builtin_key is not null;

-- manual recovery if this fails partway (module migrations run in their own
-- transaction, so a failure rolls back — but if a partial state is ever seen):
--   DROP TABLE IF EXISTS core_ai_basics;
