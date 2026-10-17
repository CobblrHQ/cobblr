-- Make or buy: a sub-assembly line takes its output part's stock before making
-- more (true, the default), or is always made (false), as every line was before.
--
-- Additive (lint:migration-additive): one column with a default, nothing existing changes.
--
-- manual recovery if this fails partway:
--   alter table builds_components drop column if exists use_stock;
alter table builds_components add column if not exists use_stock boolean not null default true;
