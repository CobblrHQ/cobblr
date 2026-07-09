-- Archive lifecycle for sync connections. A connection that ran once (or that
-- you're done with) can be ARCHIVED — tucked into a history section instead of
-- deleted, so its id-map + config survive and a one-click un-archive resumes it
-- exactly where it left off.
--
-- archived_at IS NULL  → shows in the normal sync-connections list.
-- archived_at IS NOT NULL → in the "Archived" history section; sync is off (the
--   archive action also clears sync_state.enabled/next_run_at so the poll worker
--   drops it), and the run/preview/import routes 404 until it's un-archived.
--
-- Additive + nullable → existing connections stay in the list (NULL = active).

alter table core_integrations_connectors
  add column archived_at timestamptz;
