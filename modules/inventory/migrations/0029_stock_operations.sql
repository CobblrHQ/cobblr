create table inventory_stock_operations (
  operation_id uuid not null,
  part_id uuid not null references inventory_parts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (operation_id, part_id)
);
