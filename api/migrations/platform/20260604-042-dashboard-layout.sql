-- Per-workspace ADMIN dashboard layout — the saved arrangement of the home
-- "at a glance" widgets: an ordered list of widget ids with a hidden flag.
-- Shape: { "widgets": [ { "id": "inventory", "hidden": false }, ... ] }.
-- The widget ids are owned by the web registry (registerDashboardWidget); this
-- column only stores their order + visibility. Null = no saved layout yet, so
-- the dashboard falls back to registration order with everything visible.
-- Additive + nullable, so it applies cleanly against existing org rows.
alter table orgs
  add column if not exists dashboard_layout jsonb;

comment on column orgs.dashboard_layout is
  'Admin dashboard widget arrangement { widgets: [{ id, hidden }] }; null = default order, all visible. Ids owned by the web dashboard-widget registry.';

-- manual recovery if this fails partway:
--   ALTER TABLE orgs DROP COLUMN dashboard_layout;
--   DELETE FROM migrations WHERE name LIKE '%20260604-042-dashboard-layout.sql';
