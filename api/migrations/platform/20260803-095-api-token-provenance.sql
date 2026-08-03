-- Provenance for API tokens: where a token was minted and why.
--
-- The API-recipes auto-scoping wizard mints record-scoped tokens on the user's
-- behalf. `source` records the surface that created it ("api-recipes"), and
-- `meta` carries the wizard's answers ({ kind, action, org }) so the token list
-- can show "Computers provisioning script - created from API Recipes" and an
-- audit can trace why a token exists. Both nullable: hand-minted tokens leave
-- them empty.

alter table api_tokens add column if not exists source text;
alter table api_tokens add column if not exists meta jsonb;
