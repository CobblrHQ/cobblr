-- An auto-printed batch keeps what it still owes the printer: the rendered
-- document and its printer, written in the same transaction that takes the
-- labels off the queue, until the print job is scheduled. A failure or a
-- restart between the two leaves the batch pending, and it is sent again,
-- instead of the labels vanishing from the queue with nothing printed.
--
-- Additive (lint:migration-additive): six nullable columns, nothing existing changes.
--
-- manual recovery if this fails partway:
--   alter table labels_batches drop column if exists dispatch_state, drop column if exists dispatch_printer_id,
--     drop column if exists dispatch_document, drop column if exists dispatch_labels,
--     drop column if exists dispatch_job_id, drop column if exists dispatch_error;
alter table labels_batches add column if not exists dispatch_state text;
alter table labels_batches add column if not exists dispatch_printer_id text;
alter table labels_batches add column if not exists dispatch_document bytea;
alter table labels_batches add column if not exists dispatch_labels integer;
alter table labels_batches add column if not exists dispatch_job_id text;
alter table labels_batches add column if not exists dispatch_error text;
