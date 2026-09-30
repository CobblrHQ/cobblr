-- builds — a print's verdict is the build's quality record (#4053).
--
-- The plate verdict in digifab ("9 good, 1 scrap") and this module's per-
-- operation good/scrap log were two quality records that never met. A judged
-- print now writes its counts here, against the build it produced, so yield is
-- one number. Such a row belongs to no operation of the build (a print is not
-- one of its hand operations), so operation_id may be null, and it carries the
-- job it came from so a re-delivered verdict can never count twice.
--
-- Additive: old readers select by operation_id and never see a null one.
--
-- manual recovery if this fails partway:
--   DROP INDEX IF EXISTS builds_op_qty_source_job_idx;
--   ALTER TABLE builds_op_qty DROP COLUMN IF EXISTS source_job_id;

alter table builds_op_qty alter column operation_id drop not null;
alter table builds_op_qty add column if not exists source_job_id text;
create unique index if not exists builds_op_qty_source_job_idx
  on builds_op_qty (source_job_id, kind)
  where source_job_id is not null;
