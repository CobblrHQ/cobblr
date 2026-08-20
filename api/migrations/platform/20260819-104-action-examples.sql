-- How a person asks for an action, in their own words.
--
-- The assistant's prompt lists actions as ids and labels, which says what
-- exists and not what a request for it sounds like. Additive and defaulted, so
-- an older api ignores it and a newer one sees an empty list until the next
-- boot syncs the manifests.
alter table entity_actions
  add column if not exists examples jsonb not null default '[]';
