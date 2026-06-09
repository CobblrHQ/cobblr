-- Screenshot attachments on platform feedback. A reporter can attach 1+ images
-- of the issue; they're uploaded to their own workspace's core-files, and only
-- the file refs are recorded here (the bytes are read cross-tenant server-side
-- via platform().files.read(feedback.org_id, file_id) for the super-admin view).
--
-- Each element: { "file_id": uuid, "name": text, "content_type": text }.
--
-- manual recovery if this fails partway:
--   ALTER TABLE feedback DROP COLUMN IF EXISTS attachments;
--   DELETE FROM migrations WHERE name = '20260609-050-feedback-attachments.sql';

alter table feedback add column attachments jsonb not null default '[]'::jsonb;
