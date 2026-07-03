-- Per-USER theme preference (the author): "I want all MY workspaces dark, but not for
-- anyone else and not the workspace's own skin." Follows the user across
-- devices + workspaces; NULL = follow the device / OS (the old behavior).
alter table users add column if not exists theme_pref text
  check (theme_pref is null or theme_pref in ('light', 'dark'));

-- manual recovery: ALTER TABLE users DROP COLUMN IF EXISTS theme_pref;
