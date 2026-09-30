-- What a Make was made for (an order line, a work order): kept on the Make so
-- its completion can say so, beside the made-for link both records list.
-- Additive: two nullable columns.

alter table digifab_makes add column if not exists source_kind text;
alter table digifab_makes add column if not exists source_id text;
