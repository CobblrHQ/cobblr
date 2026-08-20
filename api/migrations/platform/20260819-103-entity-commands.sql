-- Commands modules SHIP: a sentence a user would type, and what to do about it.
--
-- Synced from the manifests on every boot, exactly like entity_actions, so the
-- shipped set is code and the per-workspace set stays in the tenant. A
-- workspace's effective commands are these (for the modules it has enabled)
-- overlaid with the ones it taught itself.
--
-- Additive: an older api does not know the table exists, and a newer one finds
-- it empty until the first boot syncs it.
create table if not exists entity_commands (
  id           text primary key,
  module_name  text not null,
  template     text not null,
  description  text,
  -- Compiled from the template at sync time. Authors write the sentence.
  pattern      text not null,
  slots        jsonb not null default '[]',
  plan         jsonb not null,
  repeat_field text,
  repeat_shape text,
  version      text not null default '0.0.0',
  synced_at    timestamptz not null default now()
);

create index if not exists entity_commands_module on entity_commands (module_name);
