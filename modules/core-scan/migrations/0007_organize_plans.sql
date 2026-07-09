-- Guided Organize (docs/product/guided-organize.md): a stored put-away PLAN.
-- POST /organize/plan writes one row (the whole plan as JSON); apply validates
-- against the stored payload so what gets applied is exactly what was shown,
-- a reload mid-session can resume, and a stale plan re-plans instead of
-- applying against a drifted inbox. Rows are ephemeral working state — expired
-- plans are deleted opportunistically on the next plan/apply call.
create table core_scan_organize_plans (
  id                  uuid primary key default gen_random_uuid(),
  payload             jsonb not null,
  applied_group_ids   jsonb not null default '[]'::jsonb,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null
);
