-- AI triage verdict on feedback. A host-side `claude -p` analyzer reads new
-- feedback, judges it, and writes the result back here so super-admins get a
-- prioritized, pre-analyzed list instead of a raw queue. All columns nullable —
-- untriaged rows (triaged_at IS NULL) are what the analyzer claims.
--
-- manual recovery if this fails partway:
--   ALTER TABLE feedback
--     DROP COLUMN IF EXISTS triage_priority, DROP COLUMN IF EXISTS triage_valid,
--     DROP COLUMN IF EXISTS triage_viable,   DROP COLUMN IF EXISTS triage_summary,
--     DROP COLUMN IF EXISTS triage_action,   DROP COLUMN IF EXISTS triaged_at,
--     DROP COLUMN IF EXISTS triage_model;
--   DROP INDEX IF EXISTS feedback_triage_priority_idx;
--   DELETE FROM migrations WHERE name = '20260609-049-feedback-triage.sql';

alter table feedback
  -- urgent | high | medium | low  (sortable triage priority)
  add column triage_priority text,
  -- is it a real/coherent report? (vs spam, test, unintelligible)
  add column triage_valid    boolean,
  -- is it actionable/feasible to do? (vs out-of-scope, contradictory)
  add column triage_viable   boolean,
  -- one-paragraph analysis of what it's asking + why it matters
  add column triage_summary  text,
  -- the concrete suggested next action
  add column triage_action   text,
  add column triaged_at      timestamptz,
  -- which claude model produced the verdict (audit / re-run decisions)
  add column triage_model    text;

-- "show me the analyzed queue, highest priority first"
create index feedback_triage_priority_idx on feedback(triage_priority, created_at desc);
