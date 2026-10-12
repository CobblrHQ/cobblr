-- share_mirror_state.file_keys: which of a record's attached files the
-- owner's side has already sent to the share space, by the owner's file id
-- (#6056). A shared Pattern's PDF travels with it, its bytes once; a later
-- pass sends only a file the record did not have before.
--
-- Additive + safe: every existing row starts with none sent, so each shared
-- record's files go over once on its share's next pass.
alter table share_mirror_state add column if not exists file_keys jsonb not null default '[]'::jsonb;
