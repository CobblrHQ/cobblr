-- A per-job AI choice can name a PERSONAL connection, not only a workspace provider.
--
-- Until now a capability default said provider_id + model, and those only ever
-- meant one of the workspace's own installed providers. A personal connection
-- routed into the workspace took a different path entirely and won outright, so
-- the per-job settings on the AI page silently did nothing once somebody's own
-- key was in play, and that key's model could not be chosen at all.
--
-- Additive and nullable: a row without it behaves exactly as before.
alter table core_ai_capability_defaults
  add column if not exists credential_id text;

comment on column core_ai_capability_defaults.credential_id is
  'A personal connection (cobblr_meta.user_credentials.id) chosen for this job. Null = use the workspace''s own provider named by provider_id.';
