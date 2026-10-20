-- A print confirmed from the browser names the send it confirms, so the same
-- confirmation arriving twice (a double press, a retried request) records it
-- once. Confirming takes the sent copies off a row and keeps the rest queued
-- (#7593); without this a repeat would take the copies added after the send.
--
-- Additive (lint:migration-additive): one nullable column and a partial index.
--
-- manual recovery if this fails partway:
--   drop index if exists labels_batches_user_send_id;
--   alter table labels_batches drop column if exists send_id;
alter table labels_batches add column if not exists send_id uuid;
create unique index if not exists labels_batches_user_send_id on labels_batches (user_id, send_id) where send_id is not null;
