-- Session revocation. Add a per-user cutoff: any session/app JWT issued
-- (iat) BEFORE this timestamp is rejected by requireAuth. Set to now() on a
-- password change/reset so a stolen token can't outlive the victim's reset.
-- Nullable + no default → all existing tokens stay valid until the next
-- password change (additive, no forced logout on deploy).
-- See docs/history/2026-06-10-prelaunch-audit.md #6.
--
-- manual recovery if this fails partway:
--   ALTER TABLE users DROP COLUMN IF EXISTS tokens_valid_from;
--   DELETE FROM migrations WHERE name = '20260610-055-user-tokens-valid-from.sql';

alter table users add column if not exists tokens_valid_from timestamptz;
