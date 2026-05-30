-- digifab printer links — "this farm printer IS this Cobblr machine".
-- Lets a job linked to a machines:machine auto-route to the right farm
-- printer. machine_id is an opaque entity id (no FK to the machines
-- module — digifab doesn't import it); machine_label is cached for
-- display.

create table digifab_printer_links (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references digifab_connections(id) on delete cascade,
  farm_printer_id   text not null,
  farm_printer_name text,
  machine_id        text not null,            -- machines:machine entity id
  machine_label     text,
  created_at        timestamptz not null default now(),
  unique (connection_id, farm_printer_id)     -- one machine per farm printer
);

create index digifab_printer_links_machine_idx on digifab_printer_links(machine_id);
