-- Per-USER nav layout: "I set the sidebar, then signed in on another desktop and
-- was back on the top bar." Same argument as theme_pref (074) and the same
-- shape: follows the user across devices + workspaces, NULL = no choice made
-- yet, so the device's own default stands.
--
-- One jsonb rather than three columns because the three settings are one
-- decision. `topbar` and `autohide` only mean anything in side mode, and landing
-- on a synced sidebar in an unsynced sub-configuration is the same complaint
-- again, one level down.
--
-- Shape: {"mode":"top"|"side","autohide":bool,"topbar":bool}
-- Desktop only by construction: the sidebar renders `hidden md:block`, so a
-- phone ignores every value in here and keeps its own menu.
alter table users add column if not exists nav_pref jsonb;

-- manual recovery: ALTER TABLE users DROP COLUMN IF EXISTS nav_pref;
