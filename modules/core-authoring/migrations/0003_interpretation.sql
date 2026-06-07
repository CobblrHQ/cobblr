-- Async hosted build: the AI's plain-language read of the request + what it
-- built. Persisted on the draft so a polling client can show it once the
-- background build finishes (the request no longer blocks on the AI call).
alter table core_authoring_drafts add column interpretation text;
