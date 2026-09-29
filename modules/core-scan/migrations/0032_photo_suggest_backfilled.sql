-- When this workspace's existing records without a picture were put in the
-- picture queue once (#3818): the backfill runs a single time per workspace,
-- so a record left with none is not searched again unless its name changes
-- or a person asks. Nullable, additive.
alter table core_scan_photo_suggest_config
  add column if not exists backfilled_at timestamptz;
