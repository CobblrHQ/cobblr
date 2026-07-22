-- Opt a list OUT of a human code. A NULL prefix means "this list gets no code":
-- it frees the letter for another list and stops binding a code to items you
-- don't want coded. Relaxing NOT NULL is all it takes -- the UNIQUE index treats
-- NULLs as distinct, so any number of lists can be codeless at once and a freed
-- letter is genuinely available (no row holds it). Existing rows keep their
-- prefix, so nothing to backfill; the clear path (renameCodeGroup with a blank
-- prefix) is what sets a group to NULL, deletes its unprinted codes, and resets
-- its counter.
--
-- DOWN (manual, never auto): give every codeless group a prefix again, then
--   ALTER TABLE labels_code_prefixes ALTER COLUMN prefix SET NOT NULL;
alter table labels_code_prefixes alter column prefix drop not null;

comment on column labels_code_prefixes.prefix is
  'The group''s code prefix (globally unique). NULL means the list is opted out of a code entirely (letter freed); its items carry no code and none is minted.';
