-- PHASE: contract
-- SAFE WHEN: existing APIs read and write numeric quantities as decimal strings.
-- Precision widens while the nine-digit integer range stays the same.
alter table inventory_parts alter column qty type numeric(18,9);
alter table inventory_allocations alter column qty type numeric(18,9);

create unique index inventory_spoolman_link_unique
  on inventory_parts ((metadata->>'spoolman_connection_id'), (metadata->>'spoolman_id'))
  where metadata->>'spoolman_connection_id' is not null and metadata->>'spoolman_id' is not null;
