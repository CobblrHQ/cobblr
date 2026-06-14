-- Per-workspace AI routing (feedback 28b70300 / e176aace).
--
-- Until now a personal AI connection had ONE global route_mode (my-calls vs
-- workspace-default) applied to every workspace it reached. Users expect to
-- decide PER WORKSPACE: "Off / Just me / Share with members" — e.g. an invited
-- member of someone else's space wanting to SHARE their AI there while keeping
-- it mine-only elsewhere.
--
-- The per-workspace model rides on the existing `explicit` route_scope: each
-- routed workspace is a user_credential_orgs row, now carrying its OWN mode.
-- Row present = routed here (Just me / Share per `mode`); row absent = Off.
-- Dynamic scopes (sole_member/owner/all_mine) still use the credential's global
-- route_mode, so un-migrated connections are byte-for-byte unchanged.
--
-- Sharing governance (owner approval): a member can OFFER their AI to a
-- workspace they don't own ('workspace-default'), but it only becomes usable by
-- OTHER members once the workspace owner approves it. The offering member's OWN
-- calls work immediately (an offer never blocks your own use). `approved_at`
-- null = a pending offer; `active` = the one approved AI the owner has chosen as
-- the workspace default (at most one active per org). 'my-calls' routes ignore
-- both columns (they only ever serve their own owner).
--
-- Each migration runs in its own transaction (api/src/db/migrate.ts applyOne),
-- so a failure here rolls back cleanly and nothing is recorded in the
-- `migrations` tracker — just fix the SQL and redeploy. To re-run after a
-- SUCCESSFUL apply (rare): DELETE FROM migrations
--   WHERE name = 'platform::20260614-061-credential-org-mode.sql';

alter table user_credential_orgs
  add column mode        text not null default 'my-calls'
    check (mode in ('my-calls', 'workspace-default')),
  add column approved_at timestamptz,
  add column approved_by uuid references users(id) on delete set null,
  add column active       boolean not null default false;

-- Existing explicit-scope rows inherit their connection's global mode, and any
-- that were already workspace-default are grandfathered in as approved + active
-- (they were live before this gate existed — don't silently break them).
update user_credential_orgs uco
  set mode = uc.route_mode,
      approved_at = case when uc.route_mode = 'workspace-default' then now() else approved_at end,
      active      = case when uc.route_mode = 'workspace-default' then true else active end
  from user_credentials uc
  where uc.id = uco.credential_id;
