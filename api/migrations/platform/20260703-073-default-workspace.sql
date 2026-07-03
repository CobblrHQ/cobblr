-- Per-user DEFAULT workspace: the one a fresh device opens into (the author — "mitch"
-- kept opening because there was no way to pin a default; the fallback just
-- picked the first owned workspace). One default per user, enforced by a
-- partial unique index; the set endpoint clears the others in a transaction.
alter table org_memberships add column if not exists is_default boolean not null default false;
create unique index if not exists org_memberships_one_default_per_user
  on org_memberships (user_id) where is_default;

-- manual recovery if this fails partway:
--   DROP INDEX IF EXISTS org_memberships_one_default_per_user;
--   ALTER TABLE org_memberships DROP COLUMN IF EXISTS is_default;
