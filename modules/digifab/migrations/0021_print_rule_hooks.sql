-- Pre/post hooks on a print-update rule. Before posting, run a sequence of
-- printer controls + waits (e.g. chamber light on, wait 6s to settle) so the
-- photo looks good; after posting, run another (wait 1s, light off). Each step is
-- {"control":"light","params":{"on":true}} or {"wait_ms":6000}. The engine runs
-- them around the fire DETACHED, so the delays never block the telemetry poll.

alter table digifab_print_rules add column if not exists pre_actions  jsonb not null default '[]'::jsonb;
alter table digifab_print_rules add column if not exists post_actions jsonb not null default '[]'::jsonb;

-- manual recovery if this fails partway:
--   ALTER TABLE digifab_print_rules DROP COLUMN pre_actions, DROP COLUMN post_actions;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0021_print_rule_hooks';
