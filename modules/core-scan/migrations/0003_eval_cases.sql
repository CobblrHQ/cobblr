-- P2 of the scan-matchmaker eval harness (docs/operations/ai-prompt-eval-harness.md):
-- "Save this scan as an eval case." When a platform admin triages a real scan, we
-- capture the perceived input + the menu the model saw + the user's CORRECTED commit
-- (the ground-truth answer) so the golden set grows from real misses, not hand-authoring.
--
-- Captured per-tenant here; the super-admin surface aggregates across workspaces and the
-- e2e import script materialises these into e2e/fixtures/scan-eval/ for review + commit.
--
-- expected shape: { route: { module, instance }, fields: {<field_name>: value}, name }
-- mirrors the P1 fixture's `expect` so the import transform is near-identity.

create table if not exists core_scan_eval_cases (
  id                 uuid primary key default gen_random_uuid(),
  inbox_item_id      uuid,
  surface            text not null default 'matchmaker',
  perceived_input    jsonb not null,
  scan_menu          jsonb not null default '[]'::jsonb,
  candidates         jsonb not null default '[]'::jsonb,
  expected           jsonb not null,
  note               text,
  created_by_user_id uuid,
  created_at         timestamptz not null default now()
);

create index if not exists core_scan_eval_cases_created_at_idx
  on core_scan_eval_cases (created_at desc);
