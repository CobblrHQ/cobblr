-- A copy of a file that another file already holds, byte for byte (#3859).
--
-- The server-side writer stored the same picture again whenever a path
-- fetched it twice (a catalog photo downloaded twice seconds apart), so
-- search listed "voron-0.1-2-750x930.jpg" twice. The writer now returns the
-- file that already holds the bytes; the heal (src/heal-same-bytes.ts) marks
-- the copies made before that with the file they repeat. A marked copy stays
-- resolvable by its id, which other modules hold directly, and is left out of
-- every list. Additive: null is "an original", every existing row.

alter table core_files_files add column if not exists same_as uuid null;

create index if not exists core_files_files_sha256_idx on core_files_files (sha256, size_bytes) where deleted_at is null;
