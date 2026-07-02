-- Bundle version history (2026-07 audit F3 — "react" needs take-backs).
-- Uninstalling or updating a bundle used to DELETE its stored manifest with
-- no way back; a builder who reacts to behavior rather than reading JSON had
-- no undo. Every time a bundle row is removed (update-replace, uninstall,
-- revert-overwrite) the row's full manifest + enabled features land here
-- first, so any prior version can be re-validated and re-applied.
--
-- Write point: uninstallBundleId() in api/src/routes/bundles.ts — the ONE
-- choke point every removal path goes through. Read/revert:
-- GET /bundles/history/:externalId + POST /bundles/history/:snapshotId/revert.

CREATE TABLE bundle_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  -- why the row was removed: 'replaced' (an update/reinstall/revert put a new
  -- version in) or 'uninstalled' (explicit delete).
  reason text NOT NULL,
  manifest jsonb NOT NULL,
  enabled_features text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bundle_snapshots_org_ext_idx
  ON bundle_snapshots (org_id, external_id, created_at DESC);
