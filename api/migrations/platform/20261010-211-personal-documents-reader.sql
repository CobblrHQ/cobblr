-- Who reads a workspace's personal documents (#5621). The owner's rule
-- (#5243) stays the default: a workspace with no row here reads them on this
-- machine only (code, plus any local AI it has). An owner may instead name
-- one cloud connection the workspace already uses, after consenting in words
-- that name the company the documents go to. The row keeps that consent:
-- who, when, and the sentence they agreed to. Removing the row is going back
-- to local only.
--
-- New and empty: no workspace changes until its owner chooses.
CREATE TABLE IF NOT EXISTS org_personal_documents_reader (
  org_id uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  -- A personal connection's id, or 'workspace:<provider id>' for one of the
  -- workspace's own providers.
  connection text NOT NULL,
  provider_id text NOT NULL,
  consented_by uuid REFERENCES users(id) ON DELETE SET NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  consent_text text NOT NULL
);
COMMENT ON TABLE org_personal_documents_reader IS
  'A workspace whose owner consented to a named cloud connection reading its personal documents. No row = read on this machine only (the default).';
