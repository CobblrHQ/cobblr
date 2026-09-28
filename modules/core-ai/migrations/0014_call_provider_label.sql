-- The AI log names the connection that answered, by its own name.
--
-- A call row kept only provider_id ("edge-bridge", "google-ai-studio"): the
-- kind of AI, not the one somebody set up and would recognise ("Claude
-- bridge (Sam)"). Additive and nullable: a row from before reads as its
-- provider, as it always did.
alter table core_ai_calls add column if not exists provider_label text;
