-- How many migrations the workspace's module ledger holds, beside the name of
-- the last one. The boot-time sync decides whether to open a tenant from this
-- row alone; a name alone cannot see a migration that sorts before it (two
-- files sharing an ordinal, 2026-09-13, #2944). NULL means "never counted":
-- the next boot opens that tenant once, writes the count, and is cheap again.
alter table org_modules add column if not exists migration_count integer;
