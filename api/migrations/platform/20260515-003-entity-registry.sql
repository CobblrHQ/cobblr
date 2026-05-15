-- Entity Kind + Capability + Wire registry (Pillars A, B, C).
--
-- Modules declare entity kinds + actions they expose. The platform
-- writes them to these tables at boot. Other modules look up
-- entities + invoke actions through the platform's helpers — they
-- never import each other's code.
--
-- Wires (bindings) are user-configured per-org connections between
-- a source entity kind and an action, including the template used
-- to render the entity's data into the action's payload.

-- ─────────────────────────── entity_kinds ─────────────────────────
--
-- Kind ID format: <module>:<name> (e.g. "inventory:part"). Stable
-- identifier — bundles + bindings reference kinds by this string,
-- so renames need a deprecation-alias period.

create table entity_kinds (
  id              text primary key,
  module_name     text not null,
  display_name    text not null,
  display_name_plural text,
  icon            text,
  fields          jsonb not null default '[]'::jsonb,
  detail_route    text,
  endpoints       jsonb,
  version         text not null default '0.1.0',
  registered_at   timestamptz not null default now()
);

create index entity_kinds_module_idx on entity_kinds(module_name);

-- ─────────────────────────── entity_actions ───────────────────────
--
-- An action declares what it does + which entity kinds it applies
-- to (either an explicit list, or a "shape predicate" — needs an
-- entity with field role=title, etc.).
--
-- Action ID format: <module>:<name> (e.g. "labels:print"). Same
-- rules as entity_kinds.

create table entity_actions (
  id              text primary key,
  module_name     text not null,
  label           text not null,
  description     text,
  icon            text,
  -- Either an explicit list of entity kind IDs, or a JSON predicate
  -- like { hasFieldRole: "title" } that the platform evaluates
  -- against each registered kind.
  applies_to      jsonb not null default '{"any": true}'::jsonb,
  -- Where the platform routes the user when invoked (UI action).
  -- {entityKind}, {entityId} placeholders.
  invoke_route    text,
  -- Programmatic entry-point name registered by the module at boot
  -- via platform.actions.registerHandler. Optional — actions can
  -- be route-only.
  invoke_handler  text,
  version         text not null default '0.1.0',
  registered_at   timestamptz not null default now()
);

create index entity_actions_module_idx on entity_actions(module_name);

-- ─────────────────────────── entity_action_bindings ───────────────
--
-- Per-org user-authored "wire" — when SOMETHING happens for an
-- entity of kind X, perform action Y, rendering with template T.
--
-- For UI actions: trigger_type='user-invoked' — bindings show up
-- as buttons in EntityActionsBar.
-- For event-driven: trigger_type='event' with trigger_event set
-- (e.g. 'inventory.stock.changed') — the platform fires the action
-- when the event matches.

create table entity_action_bindings (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  source_kind     text not null,
  action_id       text not null,
  trigger_type    text not null default 'user-invoked'
                    check (trigger_type in ('user-invoked', 'event', 'on-create', 'on-update', 'on-delete')),
  trigger_event   text,
  filter          jsonb,
  template        text,
  args            jsonb,
  enabled         boolean not null default true,
  bundle_id       uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index entity_action_bindings_org_idx
  on entity_action_bindings(org_id, source_kind, enabled);
create index entity_action_bindings_event_idx
  on entity_action_bindings(trigger_event)
  where trigger_event is not null and enabled;

-- ─────────────────────────── bundles (C.2) ────────────────────────
--
-- A bundle is a publishable artifact — multiple bindings + instance
-- seeds (custom field defs, etc.) packaged together. Installed
-- per-org. bundle_installs ties the artifacts a bundle created
-- back to the bundle so uninstall removes only what came from it.

create table bundles (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  external_id     text not null,
  name            text not null,
  version         text not null,
  author          text,
  description     text,
  source_url      text,
  manifest        jsonb not null,
  installed_at    timestamptz not null default now(),
  unique (org_id, external_id, version)
);

-- entity_action_bindings.bundle_id references bundles.id (added
-- as soft ref above; explicit FK here so cascade deletes work).
alter table entity_action_bindings
  add constraint entity_action_bindings_bundle_fk
  foreign key (bundle_id) references bundles(id) on delete set null;

-- ─────────────────────────── module_field_defs (Pillar D-lite) ────
--
-- Per-org, per-module custom field definitions. Modules query the
-- platform for "extra fields" applicable to their entity kind +
-- render them on top of their built-in fields. The Lego use case
-- adds {set_id, year, theme, color} this way without inventory's
-- code knowing.

create table module_field_defs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  entity_kind     text not null,
  name            text not null,
  display_label   text not null,
  type            text not null
                    check (type in ('text', 'number', 'boolean', 'date', 'url')),
  required        boolean not null default false,
  position        integer not null default 0,
  bundle_id       uuid references bundles(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (org_id, entity_kind, name)
);

create index module_field_defs_lookup_idx
  on module_field_defs(org_id, entity_kind, position);
