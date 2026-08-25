-- Who added the tracking number, so its arrival interrupts THEM and not the
-- whole workspace. Nullable on purpose: rows from before this column simply
-- fall back to the batch creator, then to everyone.
alter table core_scan_batches
  add column if not exists tracking_added_by_user_id uuid;
