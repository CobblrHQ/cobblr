-- Premade-workspace invites: a signup invite may carry a workspace BLUEPRINT
-- (the config snapshot from routes/blueprint.ts — modules, bundles, field
-- defs, wires, views, instances; no data). Redeeming the invite provisions
-- the new workspace and applies the blueprint, so the invitee lands in a
-- workspace already configured for them ("here's your lego-club tracker").
--
-- manual recovery if this fails partway:
--   ALTER TABLE signup_invites DROP COLUMN IF EXISTS blueprint;
--   DELETE FROM migrations WHERE name = '20260702-071-invite-blueprint.sql';

alter table signup_invites add column blueprint jsonb;
