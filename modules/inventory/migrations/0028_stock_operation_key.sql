alter table inventory_consumption add column if not exists operation_key text;
create unique index if not exists inventory_consumption_operation_idx
  on inventory_consumption(part_id, operation_key) where operation_key is not null;
