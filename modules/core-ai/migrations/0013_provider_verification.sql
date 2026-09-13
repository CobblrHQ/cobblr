-- What a workspace AI connection knows about its own key (#2895).
--
-- The same verdict the personal connections keep (platform migration 123):
-- a save probes the provider once, and the row shows verified / invalid /
-- unverifiable / unverified rather than "updated". Nullable: an older row
-- reads "not checked yet" until it is tested.
ALTER TABLE core_ai_providers
  ADD COLUMN IF NOT EXISTS verification jsonb NULL;
