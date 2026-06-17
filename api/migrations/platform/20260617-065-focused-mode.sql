-- "Focused mode": a per-workspace, owner-flippable flag that hides the platform
-- BUILDER chrome (marketplace / "add modules" / the AI builder / Configuration /
-- the "+ New thing" funnel) leaving just the enabled domains + their data — so a
-- non-technical owner sees a finished app, not a toolkit. Distinct from app_mode:
-- app_mode is a hard managed-app lock-down (route guard, no switcher); focused is
-- SOFTER — the workspace stays fully navigable and the owner can always flip it
-- back, and that flip-back ("Explore the full platform") IS the upsell. false on
-- every existing row = today's full-platform behaviour. See
-- business-models/docs/02-model-catalog.md (D, productized editions).
--
-- manual recovery if this fails partway:
--   ALTER TABLE orgs DROP COLUMN focused;

alter table orgs add column focused boolean not null default false;
