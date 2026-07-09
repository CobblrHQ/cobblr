-- Guided Organize Phase 2 — the put-away walk (docs/product/guided-organize.md).
-- Walk progress (which items the user has physically placed) rides on the plan
-- row so a reload/tab-switch mid-walk resumes where it left off. Pure
-- bookkeeping: the actual filing happened at apply time; this is the checklist.
alter table core_scan_organize_plans
  add column if not exists walk_state jsonb not null default '{}'::jsonb;
