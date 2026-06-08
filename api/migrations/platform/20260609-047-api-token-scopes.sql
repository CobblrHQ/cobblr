-- Capability-scoped API tokens. A token with a non-empty `scopes` array is
-- DENY-by-default: requireAuth clamps it to the route allowlist for those
-- scopes (mirror of the H1 Tier-B app-token clamp). NULL/empty = unrestricted
-- (the legacy "same access as a browser session" behaviour) — backward-compat.
--
-- manual recovery if this fails partway:
--   alter table api_tokens drop column if exists scopes;
--   delete from migrations where name = '20260609-047-api-token-scopes.sql';

alter table api_tokens add column if not exists scopes text[];
