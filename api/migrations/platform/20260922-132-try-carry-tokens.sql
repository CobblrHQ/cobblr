-- "Bring what I built": the person's own grant to read their trial from another
-- deployment (docs/design-decisions/trial-ledger.md, the replay).
--
-- A sandbox's ending offers to carry what the person built into a real account,
-- and that account may live on a different box with a different database. So
-- nothing is copied between databases: the demo box hands the person a token,
-- the real account's server presents it back, and the demo box answers with the
-- ledger, the shape and the records it names, as that person would read them.
--
-- Hashed like every other bearer token here: the plaintext travels once, in the
-- address the person follows, so a dump of this table opens nothing. It dies
-- with the workspace (the trial's reaper drops the org, the cascade drops this),
-- and on its own clock well before that.
create table if not exists try_carry_tokens (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  -- Not single-use: a replay that fails halfway is worth retrying, and the
  -- destination refuses a second replay of one token into one workspace on
  -- its own. Recorded so "did anybody ever carry it" is answerable.
  last_read_at timestamptz,
  read_count  integer not null default 0
);

create index if not exists try_carry_tokens_org_idx on try_carry_tokens (org_id);
