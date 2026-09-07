-- Who in a workspace a kind of notification is FOR.
--
-- Every workspace-wide notification (things to use up, maintenance due, an
-- order that should have arrived) reached every member, because the emitters
-- fan out over the member list and nothing could say otherwise. A household
-- workspace with a guest in it told the guest what was going off in the fridge
-- (2026-09-07). The per-person channel bindings decide HOW someone is told,
-- never WHETHER they are one of the people to tell.
--
-- One row per (workspace, kind). No row = everyone, which is every existing
-- workspace today, so nothing already deployed reads differently.
--   mode 'all'     every current member
--   mode 'owners'  the workspace's owners only
--   mode 'custom'  exactly the people in user_ids (intersected with live
--                  membership at dispatch, so a removed member drops out)
CREATE TABLE IF NOT EXISTS notification_audiences (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('all', 'owners', 'custom')),
  user_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, event_type)
);

COMMENT ON TABLE notification_audiences IS
  'Per workspace, per notification kind: who it is for. Absent = every member. The dispatcher drops a recipient outside the audience before writing anything.';
