-- A connection the platform made on someone's behalf, keyed by what it was
-- made from, so doing it again makes nothing twice.
--
-- A heal that moves an older store onto connections (a print-failure
-- detector's settings becoming an adapter connection) runs on every boot
-- until it has nothing left to do. `origin_key` names the source row
-- ("digifab_detectors:<id>"): createWorkspaceConnection returns the
-- connection already made for it instead of a second one. Null for every
-- connection a person made at the form.
--
-- Additive: a nullable column and a partial unique index.
--
-- manual recovery if this fails partway:
--   DROP INDEX IF EXISTS user_credentials_origin_key;
--   ALTER TABLE user_credentials DROP COLUMN IF EXISTS origin_key;
--   DELETE FROM migrations WHERE name = '20261001-177-credential-origin-key.sql';

alter table user_credentials add column if not exists origin_key text;

create unique index if not exists user_credentials_origin_key
  on user_credentials (origin_key)
  where origin_key is not null;
