-- Give import provenance its own column instead of squatting on `origin`.
--
-- The scan importer deduped re-imported sessions by writing
-- `origin = 'import:<source_batch_id>'` - overwriting the exported origin, so a
-- receipt session that arrived by email on the source lost its "emailed <when>"
-- rendering on the destination. Provenance and origin are different facts and
-- get different columns.
--
-- The UPDATE heals sessions imported under the old scheme: their provenance
-- moves here, and origin returns to null (the original value is unknowable; the
-- next sync restores it from the source, since batch reuse now refreshes
-- label/origin/vendor/order_ref).
alter table core_scan_batches add column if not exists import_source_id text;
update core_scan_batches
   set import_source_id = substring(origin from 8), origin = null
 where origin like 'import:%';
create index if not exists core_scan_batches_import_src_idx
  on core_scan_batches (import_source_id);
