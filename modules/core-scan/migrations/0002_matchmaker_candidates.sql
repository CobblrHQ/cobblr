-- Scan matchmaker: persist the ranked routing candidates the AI produced for a
-- scanned item (which table(s) it best fits + the fields it filled), so the
-- inbox can show them as tap chips without re-running the model. See
-- services/matchmaker.ts + docs/BACKLOG.md "Scan matchmaker".
--
-- Shape: [{ module, instance, kind, label, confidence, name, fields:{…} }, …].
-- Empty/absent = not matched yet (or no workspace tables to match against).

alter table core_scan_inbox_items add column if not exists suggested_candidates jsonb not null default '[]'::jsonb;
