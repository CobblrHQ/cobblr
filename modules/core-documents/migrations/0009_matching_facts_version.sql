-- The outgoing api may mark a migration's queued records done during rollout.
-- Only the replacement matcher stamps this after rereading their identity,
-- so those records remain eligible even if the old api consumed the requeue.
alter table core_documents_records
  add column facts_version integer not null default 0;
