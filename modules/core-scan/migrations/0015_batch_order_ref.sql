-- Store the receipt session's vendor + order/invoice number as their own columns
-- (not just baked into `label`), so the user can EDIT the order # on the session
-- and we can recompute "Receipt · <vendor> #<ref>" from the parts. Additive +
-- nullable; existing sessions keep their label and just have these null until a
-- re-parse or an edit fills them.

alter table core_scan_batches add column if not exists vendor    text;
alter table core_scan_batches add column if not exists order_ref text;
