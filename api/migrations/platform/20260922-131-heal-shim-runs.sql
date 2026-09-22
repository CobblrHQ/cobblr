-- What each one-shot heal shim found, the last time it ran here.
--
-- Every shim carries a `DONE WHEN:` line naming the condition under which it
-- gets deleted, and lint:heal-shims keeps that line honest. Nothing ever
-- checked whether the condition had come TRUE: the deletion pass was a person
-- reading boot logs on every deployment, which is how the lens shims sat a
-- month past their cutover. A log also dies with its container, and two of
-- the six deployments are not ones whose logs anybody reads.
--
-- So each pass records what it found, here, and /healthz reports it. "Has
-- this shim done nothing anywhere for long enough to delete it" becomes one
-- read per deployment over HTTPS (#3453).
--
-- zero_since is the useful column: set the first time a pass finds nothing
-- AND fails nowhere, cleared the moment it finds something or cannot look at
-- a workspace, so "nothing since <date>" is a fact rather than a memory. A
-- workspace the pass could not read is not a workspace with nothing to heal.
create table if not exists heal_shim_runs (
  shim          text primary key,
  last_run_at   timestamptz not null,
  last_found  integer not null,
  last_failed   integer not null default 0,
  zero_since    timestamptz
);
