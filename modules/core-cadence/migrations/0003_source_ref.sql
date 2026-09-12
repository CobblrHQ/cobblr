-- Which thing filed this row, so it can be taken back by that thing.
--
-- A scan attach files its purchase through the stock.observed subscriber,
-- which hands no event id back to the caller, and the ledger held no other
-- handle: undoing the attach could reverse the count but never void the
-- purchase, and an "adjust -n" does not un-teach a purchase the model learned
-- an interval from. `source_ref` is the announcer's own reference to the
-- thing that caused the row ("core-scan:inbox:<itemId>"); remove-event
-- accepts it and deletes every row carrying it.
--
-- Additive: a nullable column the previously deployed api never reads or
-- writes; every existing row stays as it is.
alter table core_cadence_events add column source_ref text;

create index core_cadence_events_source_ref_idx
  on core_cadence_events (source_ref)
  where source_ref is not null;
