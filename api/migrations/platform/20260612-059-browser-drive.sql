-- Browser drive grants (Feature 3 — Claude drives the web app you have open).
-- The STANDING permission for an external driver (Claude via MCP) to navigate /
-- observe a user's open tab in one workspace. Default OFF; the relay refuses to
-- act without a grant, and to navigate/observe only as the mode allows. The
-- drive SESSION itself is ephemeral (an in-memory SSE relay — see
-- platform/drive-hub.ts); only this standing permission is persisted.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS browser_drive_grants;
--   DELETE FROM migrations WHERE name = '20260612-059-browser-drive.sql';

create table browser_drive_grants (
  user_id    uuid not null references users(id) on delete cascade,
  org_id     uuid not null references orgs(id) on delete cascade,
  mode       text not null default 'off',  -- off | navigate | navigate_observe
  updated_at timestamptz not null default now(),
  primary key (user_id, org_id)
);
