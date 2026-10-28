-- A part line comes back to stock when a fabrication job is scrapped or
-- cancelled after it ran (true), or stays used up (false, the default): a
-- print melts its filament whatever the verdict (#8758).
--
-- Additive (lint:migration-additive): one column with a default, nothing existing changes.
--
-- manual recovery if this fails partway:
--   alter table builds_components drop column if exists recoverable;
alter table builds_components add column if not exists recoverable boolean not null default false;
