-- Driver-specific settings as DATA on the printer row.
--
-- cups/edge printers are fully described by (base_url, queue, credentials). A
-- browser-Bluetooth printer is not: it needs its command dialect, media width and
-- calibrated geometry, and those must live with the printer rather than be
-- compiled into the front end — otherwise "support a new printer" stops being a
-- data entry.
--
-- Deliberately a GENERIC settings blob, not bluetooth_* columns: the next driver
-- that needs its own knobs uses the same slot. Additive with a default, so
-- existing rows are valid immediately and older workspaces heal on the next boot
-- migration sync.

alter table core_print_printers
  add column if not exists settings jsonb not null default '{}'::jsonb;

comment on column core_print_printers.settings is
  'Driver-specific settings. browser-bluetooth: { profileId?, protocol, widthDots, writeCharUuid?, labelHeightMm?, gapMm?, direction?, topMarginDots?, density?, speed? }';

-- manual recovery if this fails partway:
--   ALTER TABLE core_print_printers DROP COLUMN settings;
