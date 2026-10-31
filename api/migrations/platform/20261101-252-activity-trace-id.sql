-- A History line that might be written twice carries a trace id: the id of
-- the write it records, kept in the workspace until the line reaches here.
-- A line recovered after a crash, or sent again after this database refused
-- it, is inserted with `on conflict do nothing` on that id, so it lands once.
-- Null on every other line (the index holds none of them). Additive.
alter table activity_log add column if not exists trace_id uuid;
create unique index if not exists activity_log_trace_id_uq on activity_log (trace_id) where trace_id is not null;

-- Where a round must look, answered without opening a workspace: a writer
-- marks its workspace (at most once a minute per process) before it leaves
-- an intent there; a round opens only workspaces whose mark is newer than
-- what a visit last covered. An idle workspace is never opened, at boot or
-- after (#9013: a pass that opened every workspace took staging's database
-- to 200-380% CPU). Additive.
create table if not exists activity_trace_marks (
  org_id      uuid primary key references orgs(id) on delete cascade,
  touched_at  timestamptz not null,
  covered_at  timestamptz,
  visited_at  timestamptz
);
