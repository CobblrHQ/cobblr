-- Per-org override of an action's appliesTo predicate.
--
-- Modules declare an action's default predicate in their manifest
-- (e.g. labels:print -> { traits: ["physical"] }). The platform
-- writes that default into entity_actions.applies_to at boot.
--
-- This table layers per-org adjustments on top — the user wants
-- labels:print to also apply to digital things in *their* workspace,
-- without changing the manifest. One row per (org, action). Absence
-- of a row = use the manifest default.
--
-- Override shape mirrors ActionAppliesTo from platform-contract:
--   { any: true }                          — universal override
--   { traits: [...], kinds: [...], hasFieldRole: ... }   — adjusted
--
-- The action matcher reads this table when deciding whether an action
-- shows up on a given entity kind for a given org.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS entity_action_org_overrides;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260515-011-action-overrides';

create table entity_action_org_overrides (
  org_id              uuid not null references orgs(id) on delete cascade,
  action_id           text not null references entity_actions(id) on delete cascade,
  applies_to_override jsonb not null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references users(id),
  primary key (org_id, action_id)
);

create index entity_action_org_overrides_org_idx
  on entity_action_org_overrides(org_id);
