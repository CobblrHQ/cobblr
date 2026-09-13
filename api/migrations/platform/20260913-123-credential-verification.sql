-- What a personal connection knows about its own key (#2895).
--
-- A save probes the provider once and keeps the verdict here: verified (with
-- the model and when), invalid (with the provider's reason), unverifiable (a
-- quota or an unreachable provider), or unverified (saved on the person's
-- say-so). Read by the connections page, the save toast and the Test button.
-- Additive and nullable: a row without one reads "not checked yet".
ALTER TABLE user_credentials
  ADD COLUMN IF NOT EXISTS verification jsonb NULL;
