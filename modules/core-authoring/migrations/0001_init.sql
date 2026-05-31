-- core-authoring — the AI bundle builder (create-bundle task).
--
-- One row per authoring DRAFT. A draft is the whole lifecycle of one
-- build attempt: the intent, the exact context injected (snapshot, for
-- eval reproducibility), the compiled prompt, the candidate manifest the
-- model returned, its validation result, and the status. Every row
-- doubles as a labelled eval example (the copy-paste corpus) — see
-- docs/design-decisions/ai-bundle-builder.md §6.
--
-- manual recovery if this fails partway (per-tenant DB; tracked in the
-- tenant's `migrations` table as
-- `tenant <orgId> / module core-authoring::0001_init.sql`):
--   DROP TABLE IF EXISTS core_authoring_drafts;
--   DELETE FROM migrations WHERE name LIKE '%module core-authoring::0001_init.sql';
create table core_authoring_drafts (
  id               uuid primary key default gen_random_uuid(),
  task             text not null default 'create-bundle',  -- authoring task type (extensible)
  intent           text not null,                          -- user's plain-English request
  selected_kinds   jsonb not null default '[]'::jsonb,     -- entity-kind ids scoped in
  context_snapshot jsonb,                                  -- exact context injected (eval reproducibility)
  compiled_prompt  text not null,
  mode             text not null default 'copy-paste',     -- 'copy-paste' | 'hosted'
  model            text,                                   -- hosted: which model produced it
  candidate        jsonb,                                  -- the manifest the model returned
  validation       jsonb,                                  -- { valid, errors[], preview }
  repair_attempts  int not null default 0,
  status           text not null default 'draft',          -- draft|prompt-built|candidate|validated|applied|refused
  parent_draft_id  uuid references core_authoring_drafts(id), -- refine lineage (Phase 3)
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index core_authoring_drafts_status_idx on core_authoring_drafts(status);
create index core_authoring_drafts_created_at_idx on core_authoring_drafts(created_at desc);
