-- Add an optional image to a Knowledge Base entry — e.g. a screenshot of a
-- scanner's CONFIG barcode (exact Code-128; stored as an image, never
-- regenerated — spec §3.5), or any visual reference. `image_path` is a
-- core-files raw URL (/api/v1/orgs/<slug>/modules/core-files/files/<id>/raw),
-- set by the /entries/:id/image upload route.
--
-- Additive + nullable → applies cleanly to every existing row.
--
-- manual recovery if this fails partway:
--   ALTER TABLE knowledge_entries DROP COLUMN image_path;
--   DELETE FROM migrations WHERE name LIKE '%module knowledge::0002_image.sql';

alter table knowledge_entries add column if not exists image_path text;
