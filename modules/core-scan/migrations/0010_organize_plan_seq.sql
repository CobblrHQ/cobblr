-- Guided Organize plans: a MONOTONIC insertion-order key so "newest plan wins"
-- is deterministic. The plan-selection queries (POST /organize/plan's draft
-- reuse + hint carry, and GET /organize/plan/latest) order by created_at desc
-- to pick the most recent plan. created_at defaults to now() and two plans
-- created in quick succession (separate requests within the same clock tick)
-- can share a timestamp — Postgres then returns the tie in ARBITRARY order, so
-- `.find`/`limit 1` intermittently picked the OLDER plan. That surfaced as a
-- flaky scan-putaway test (a hinted plan not surviving close/reopen). seq is a
-- total order by insertion, so `created_at desc, seq desc` breaks the tie
-- correctly and stably. Ephemeral rows (swept on expiry) — backfill order for
-- any pre-existing rows is irrelevant.
--
-- manual recovery if this fails partway:
--   ALTER TABLE core_scan_organize_plans DROP COLUMN seq;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0010_organize_plan_seq';
alter table core_scan_organize_plans
  add column seq bigserial;
