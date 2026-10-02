-- Read every part's measured values again: the reader now knows lengths
-- ("10 mm", "3/8 in", "1-1/4\"") as well as the electrical units, so a part
-- named "10 mm socket" answers a search for 10 mm. Readings are derived data
-- (0013), kept against a hash of the text they were read from, so a change in
-- the READER is invisible to that hash and the old readings would stand.
--
-- Marking them never-read hands every row to the existing heal pass
-- (heal-measure-readings.ts) and to the read-before-search in
-- refreshMeasureReadings. No record is changed; only the derived column is
-- emptied. Under an api that predates lengths it reads the same values again,
-- harmlessly.
--
-- Idempotent: running it twice only re-reads twice.

update inventory_parts set measures = null, measures_for = null where measures is not null;
