-- A prompt-driven purchase is not a manual one.
--
-- A Discord DM can carry a button that files a purchase or a consumption event.
-- That write goes into the same ledger that PRODUCED the prompt, which is a
-- feedback loop on a signal that has twice shipped confidently wrong (a ledger
-- split across two entity kinds; a same-day top-up halving every learned
-- interval), both reading confidence: good.
--
-- So the source has to be distinguishable BEFORE the first one is written. Once
-- prompt-driven events are indistinguishable from things a person typed, a rate
-- cannot be audited and a distortion cannot be discounted without guessing.
--
-- PHASE: expand. Widening a CHECK accepts everything it accepted before, so the
-- previously deployed api keeps writing 'manual'/'scan'/'list' happily.
alter table core_cadence_events
  drop constraint core_cadence_events_source_check;

alter table core_cadence_events
  add constraint core_cadence_events_source_check
    check (source in ('scan', 'list', 'manual', 'wire', 'checkin', 'prompt'));
