-- Capture-first onboarding: "write something down" is a NOTE capture — free
-- text the user typed, identified by the matchmaker against the flagship bundle
-- menu exactly like a scan (the perceived item IS the text). Widen the
-- source_kind check to admit it.
--
-- manual recovery if this fails partway:
--   alter table core_scan_inbox_items drop constraint if exists core_scan_inbox_items_source_kind_check;
--   alter table core_scan_inbox_items add constraint core_scan_inbox_items_source_kind_check
--     check (source_kind in ('barcode','photo','url','receipt'));
--   delete from _prisma_migrations where migration_name = '0003_note_source';

alter table core_scan_inbox_items
  drop constraint if exists core_scan_inbox_items_source_kind_check;

alter table core_scan_inbox_items
  add constraint core_scan_inbox_items_source_kind_check
  check (source_kind in ('barcode', 'photo', 'url', 'receipt', 'note'));
