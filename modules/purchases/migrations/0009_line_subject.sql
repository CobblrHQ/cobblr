-- An order line can stand for any record, not only an inventory part (#3856).
--
-- A printer bought on a marketplace is a machine; its order line could only
-- name a part, so the order could never open the printer and the printer
-- could never say what it cost. `subject_kind` + `subject_id` name the thing
-- a line bought, whatever module owns it. `part_id` stays and is still set
-- for a part, so every reader of it (arrival restocks, price history) keeps
-- working unchanged.
alter table purchases_order_items add column if not exists subject_kind text;
alter table purchases_order_items add column if not exists subject_id text;

update purchases_order_items
   set subject_kind = 'inventory:part', subject_id = part_id::text
 where part_id is not null and subject_id is null;

create index if not exists purchases_order_items_subject_idx
  on purchases_order_items(subject_kind, subject_id);
