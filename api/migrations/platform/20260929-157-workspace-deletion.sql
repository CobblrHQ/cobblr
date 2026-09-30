-- An owner deletes a workspace the way CLAUDE.md section 7 says a workspace
-- ends: they can take a backup, then a grace period, then the database is
-- dropped. The request is stamped here and the drop is done by
-- platform/reap-deletions.ts once `deletion_due_at` has passed. Until then the
-- workspace works as before, every member sees the date, and an owner can
-- keep it (which clears all three). NULL everywhere = no deletion asked for.
-- Additive: nullable columns, read by nothing that predates them.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS deletion_requested_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS deletion_due_at timestamptz;
CREATE INDEX IF NOT EXISTS orgs_deletion_due_idx ON orgs (deletion_due_at) WHERE deletion_due_at IS NOT NULL;

-- The backup taken just before a workspace set to be deleted is dropped. The
-- drop does not happen unless this row and its file exist (reap-deletions.ts),
-- so a deleted workspace is never gone without a copy its owners can fetch
-- from their account until `expires_at`. The zip is on disk (it can be large),
-- under the retained-exports folder beside the uploaded files, named by `id`.
--
-- org_id carries NO foreign key on purpose: the workspace is dropped right
-- after, and this row has to outlive it. owner_ids is who may download it:
-- the workspace's owners at the moment it went.
CREATE TABLE IF NOT EXISTS workspace_final_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  org_name text NOT NULL,
  owner_ids uuid[] NOT NULL,
  filename text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  download_count integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS workspace_final_exports_expiry_idx ON workspace_final_exports (expires_at);
