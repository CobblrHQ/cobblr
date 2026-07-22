-- Per-GROUP "draw the code in the QR center" override.
--
-- overlay_center used to live only on labels_code_config, keyed by entity_kind,
-- so every instance of a kind was forced to match: you couldn't show the code
-- for your 3D-printers list but hide it for CNC (both machines:machine). This
-- moves the toggle down to the code group (the per-instance / per-grouping-value
-- counter), where it belongs.
--
-- NULL = inherit the kind's default (labels_code_config.overlay_center, else the
-- module-declared default). So this is fully additive and self-healing: every
-- existing group is NULL and keeps behaving exactly as before; only a per-group
-- toggle sets a concrete value.
--
-- manual recovery if this fails partway:
--   ALTER TABLE labels_code_prefixes DROP COLUMN overlay_center;

alter table labels_code_prefixes
  add column overlay_center boolean;

comment on column labels_code_prefixes.overlay_center is
  'Per-group override for drawing the human code in the QR center. NULL inherits the kind default (labels_code_config, then the module-declared default). Lets two instances of one kind differ (3d-printers on, cnc off).';
