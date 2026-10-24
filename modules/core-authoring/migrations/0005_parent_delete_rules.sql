ALTER TABLE core_authoring_drafts DROP CONSTRAINT IF EXISTS core_authoring_drafts_parent_draft_id_fkey;
ALTER TABLE core_authoring_drafts ADD CONSTRAINT core_authoring_drafts_parent_draft_id_fkey
  FOREIGN KEY (parent_draft_id) REFERENCES core_authoring_drafts(id) ON DELETE SET NULL;
