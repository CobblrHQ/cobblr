-- The delivery date a SHIPPING NOTICE promised ("Arriving today"), on the
-- session itself. A receipt's promised date lives on its lines; a parcel known
-- only from its shipping email has no lines yet, and the sweep's arrival-day
-- rule needs the date somewhere it can read. Nullable, additive.
alter table core_scan_batches
  add column if not exists expected_arrival date;
