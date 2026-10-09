-- "Latest" per model family (#5417).
--
-- Claude's models are now listed from the provider, and each family offers a
-- "latest" that moves when a newer model appears (claude-haiku-latest means
-- Haiku 5.5 today). A choice of latest is kept in a NEW column, model_follows,
-- beside a concrete model in `model`: the api deployed before this one reads
-- only `model` and sends it, and on the canary channel it reads these same
-- tables, so `model` must always name a model a provider serves.
--
-- Every Claude selection that exists before this runs was made from a list
-- that had no "latest", so it becomes its family's latest: model_follows is
-- set, and a workspace on Haiku 4.5 is now served by Haiku 5.5 and told once
-- (the upgrade rows left in core_ai_model_state, said by the platform when
-- the provider's listing first shows what latest means). A selection made
-- after this runs is saved exactly as picked and never moved; this file runs
-- once per workspace, so it cannot touch one.
--
-- Only the Anthropic adapter's ids: claude-<family>-<version>, on a row that
-- names the anthropic provider, or a personal connection (whose provider the
-- workspace cannot see, and whose Claude ids only that adapter serves).

alter table core_ai_capability_defaults
  add column if not exists model_follows text;

alter table core_ai_chat_prefs
  add column if not exists model_follows text;

comment on column core_ai_capability_defaults.model_follows is
  'A family''s latest (claude-haiku-latest) when that was chosen; the call then uses the newest listed model of the family. Null = model is an exact choice.';

create table if not exists core_ai_model_state (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

comment on table core_ai_model_state is
  'What the AI must say once per workspace: latest:<provider>:<family> = the model latest last meant; retired:<provider>:<model> = a retired pin already reported; upgrade:<provider>:<family> = the model a selection named before latest existed, until its notice is said.';

insert into core_ai_model_state (key, value)
select distinct on (family) 'upgrade:anthropic:' || family, model
from (
  select substring(model from '^claude-([a-z]+)-[0-9]') as family, model
  from core_ai_capability_defaults
  where provider_id = 'anthropic' and model ~ '^claude-[a-z]+-[0-9]' and model_follows is null
  union all
  select substring(model from '^claude-([a-z]+)-[0-9]') as family, model
  from core_ai_chat_prefs
  where (provider_id = 'anthropic' or (provider_id is null and credential_id is not null))
    and model ~ '^claude-[a-z]+-[0-9]' and model_follows is null
) chosen
order by family, model
on conflict (key) do nothing;

update core_ai_capability_defaults
set model_follows = 'claude-' || substring(model from '^claude-([a-z]+)-[0-9]') || '-latest'
where provider_id = 'anthropic' and model ~ '^claude-[a-z]+-[0-9]' and model_follows is null;

update core_ai_chat_prefs
set model_follows = 'claude-' || substring(model from '^claude-([a-z]+)-[0-9]') || '-latest'
where (provider_id = 'anthropic' or (provider_id is null and credential_id is not null))
  and model ~ '^claude-[a-z]+-[0-9]' and model_follows is null;
