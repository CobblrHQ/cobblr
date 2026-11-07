-- A picture a person took back while its scan was still on the way (#9271). The
-- upload had finished and the scan had not reached the server, so there was no row
-- to discard. This says the file is gone, and a scan arriving late is refused.
--
-- Additive (lint:migration-additive): a new table, written only by a take-back.
CREATE TABLE IF NOT EXISTS core_scan_pictures_taken_back (
  file_id uuid PRIMARY KEY,
  taken_back_at timestamptz NOT NULL DEFAULT now()
);
