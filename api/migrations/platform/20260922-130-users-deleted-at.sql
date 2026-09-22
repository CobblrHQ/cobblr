-- An account that was deleted but whose row has to stay: something still
-- points at it without a delete rule (feedback it filed, invites it created,
-- an operator session it ran), so the row is kept as an anonymised tombstone
-- rather than dropped. deleted_at says which rows those are; every other
-- column that was the person's is cleared by the delete (platform/delete-user.ts).
-- Additive: nullable, no default needed.
alter table users add column if not exists deleted_at timestamptz;
