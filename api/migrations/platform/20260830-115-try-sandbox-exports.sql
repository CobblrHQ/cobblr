-- "Email me my work": the one file a sandbox visitor is allowed to take with them.
--
-- A sandbox deletes itself after an hour and says so plainly, and that promise is
-- what makes handing out anonymous databases to strangers safe. This does not
-- weaken it. The tenant DATABASE is still dropped on the hour by the reaper,
-- untouched. What survives is a single export artifact, and only for somebody who
-- asked for one by giving us an address to send it to. Anyone who does not ask
-- leaves nothing behind, exactly as the page tells them.
--
-- org_id carries NO foreign key on purpose. The org it came from is dropped an
-- hour later; the export has to outlive it, which is the entire point. It is kept
-- as a plain id for support and for counting, not as a live reference.
--
-- The zip lives in the row rather than on a volume: a sandbox is one hour of work
-- with an 8 MB upload ceiling, so these are small, and a row costs no new mount,
-- no orphan sweep of its own, and rides the existing meta backup.
create table if not exists try_sandbox_exports (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  email         text not null,
  -- Hashed like every other bearer token here: the plaintext is in one email
  -- and nowhere else, so a dump of this table opens nothing.
  token_hash    text not null unique,
  filename      text not null,
  bytes         bytea not null,
  size_bytes    integer not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  -- Not single-use: people click the same link twice, and on a second device.
  -- Recorded so "did they ever fetch it" is answerable.
  first_downloaded_at timestamptz,
  download_count integer not null default 0
);

-- The reaper's sweep, and the only query that runs on a timer.
create index if not exists try_sandbox_exports_expiry_idx
  on try_sandbox_exports (expires_at);

-- One live export per address at a time is plenty, and it stops a loop from
-- filling the table by asking repeatedly.
create index if not exists try_sandbox_exports_email_idx
  on try_sandbox_exports (email, created_at desc);
