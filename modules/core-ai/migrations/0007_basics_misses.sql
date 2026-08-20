-- The questions basic mode could NOT answer, so the corpus can grow from what
-- people actually ask instead of from what we imagined they would.
--
-- There was no way to find out. Chat turns are swept after a day and the AI
-- call log stores the request envelope rather than the question, so "which
-- phrases should we match that we don't?" had no data behind it at all — the
-- only evidence was someone remembering a bad answer.
--
-- Scoped to the workspace that asked, deduped by the matcher's own normalized
-- form (so "How do I add a part?" and "how do i add a part" are one row with a
-- count of 2), and never written when a rule DID match. Nothing here leaves the
-- workspace.
create table core_ai_basics_misses (
  id          uuid primary key default gen_random_uuid(),
  -- The matcher's normalize() output: what dedup is keyed on.
  normalized  text not null unique,
  -- What was actually typed, most recent wording, for a person to read.
  sample      text not null,
  times       integer not null default 1,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  -- Set when someone has dealt with it (made a rule, or decided not to), so
  -- the list stays a to-do rather than an ever-growing log.
  dismissed   boolean not null default false
);

create index core_ai_basics_misses_recent
  on core_ai_basics_misses (dismissed, last_seen desc);
