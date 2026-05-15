-- Pairings — a generic polymorphic relationship primitive.
--
-- Any module can write "(source_kind, source_id) is related to
-- (target_kind, target_id) as a `relationship_kind`." Generalises
-- the dep pattern that lives in projects_task_dependencies today
-- (task-depends-on-part is conceptually a pairing with
-- relationship_kind='depends-on'). The projects table stays as-is
-- for now; consolidation happens once UIs migrate over.
--
-- relationship_kind is freeform on purpose so modules + bundles
-- can define their own without a schema change. Common values the
-- platform itself will use: 'accessory-of', 'spare-for', 'depends-on',
-- 'consumable-on', 'modifies'. Convention: hyphenated, present-tense,
-- read as "source <verb> target".

create table entity_pairings (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete cascade,
  -- Polymorphic source. Kind is "<module>:<thing>" matching the
  -- entity-kind registry; id is whatever the module uses (uuid for
  -- platform-level modules, text for anything custom).
  source_kind        text not null,
  source_id          text not null,
  target_kind        text not null,
  target_id          text not null,
  relationship_kind  text not null,
  notes              text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  created_by         uuid references users(id) on delete set null
);

create index entity_pairings_source_idx
  on entity_pairings(org_id, source_kind, source_id);
create index entity_pairings_target_idx
  on entity_pairings(org_id, target_kind, target_id);
create index entity_pairings_rel_idx
  on entity_pairings(org_id, relationship_kind);

-- Same-row pairing in both directions (A→B and B→A) is allowed
-- because some relationships are asymmetric ("accessory-of" doesn't
-- imply "primary-for" in the reverse). Modules that want symmetric
-- can write both rows.
