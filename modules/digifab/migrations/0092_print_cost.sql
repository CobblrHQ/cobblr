-- What a finished print cost: its filament priced from the spool it came off,
-- plus machine time when the printer or its pool has an hour rate. Empty when
-- any of it could not be priced, which reads as "not priced", never as zero.
--
-- Additive (lint:migration-additive): five nullable columns, nothing existing changes.
--
-- manual recovery if this fails partway:
--   alter table digifab_jobs drop column if exists cost_amount, drop column if exists cost_currency, drop column if exists cost_detail;
--   alter table digifab_device_settings drop column if exists hour_rate, drop column if exists hour_rate_currency;
alter table digifab_jobs add column if not exists cost_amount numeric;
alter table digifab_jobs add column if not exists cost_currency text;
alter table digifab_jobs add column if not exists cost_detail jsonb;

-- What an hour of this printer costs, in its currency (a pool's lives in its config).
alter table digifab_device_settings add column if not exists hour_rate numeric;
alter table digifab_device_settings add column if not exists hour_rate_currency text;
