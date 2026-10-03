-- A successful library copy is durable record state, not only a service job.
-- It lets the record say the copy is complete after a reload and attributes
-- the completion entry to the person who asked for it.

alter table core_documents_linked
  add column copied_at timestamptz,
  add column copied_filename text,
  add column copied_file_id text,
  add column copy_requested_by uuid;
