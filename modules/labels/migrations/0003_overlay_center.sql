-- Per-kind toggle: draw the human-readable code in the QR center, or not.
-- Some kinds are singular enough that the code adds nothing (there is only one
-- "Office" in a house — unlike "monitor 5 of 17"). Additive + defaulted true, so
-- every existing kind keeps today's behavior until a user turns it off.
-- See docs/design-decisions/label-codes.md.
--
-- manual recovery if this fails partway (per-tenant DB — tracking lives in that
-- DB's own `migrations` table, keyed name = "<scope>::<filename>"):
--   ALTER TABLE labels_code_config DROP COLUMN IF EXISTS overlay_center;
--   DELETE FROM migrations WHERE name LIKE '%module labels::0003_overlay_center.sql';

alter table labels_code_config
  add column overlay_center boolean not null default true;
