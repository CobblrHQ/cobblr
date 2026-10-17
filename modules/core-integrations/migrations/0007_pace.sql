-- Pacing that holds across api processes. A connection's sends go out at least
-- an interval apart (Slack one a second, a webhook as its owner says); the next
-- free slot is kept here, claimed with one atomic update, so two api processes
-- cannot both take the same second. Additive: a connection with no row has not
-- sent yet. The row goes with its connection.
create table core_integrations_pace (
  connection_id uuid primary key references core_integrations_connectors(id) on delete cascade,
  next_at       timestamptz not null default now()
);
