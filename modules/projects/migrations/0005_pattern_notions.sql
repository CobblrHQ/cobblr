-- A pattern's notions (stitch markers, a yarn needle, safety eyes, stuffing)
-- are needs too, beside its yarns and its hooks or needles.
--
-- Widening the kinds a row may be: every row the previous api wrote is still
-- one of them, and that api never writes 'notion', so it runs unchanged.
-- PHASE: contract
-- SAFE WHEN: only widens the allowed set; no existing row or older writer is refused by it.

alter table projects_pattern_needs drop constraint if exists projects_pattern_needs_kind_check;
alter table projects_pattern_needs
  add constraint projects_pattern_needs_kind_check check (kind in ('yarn', 'hook', 'needle', 'notion'));
