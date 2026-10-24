-- Explicit asset numbers in an older backup did not advance this counter.
-- Recovery: rerun after correcting the connection; advancing it is idempotent.
select setval('inventory_parts_asset_id_seq', restored.maximum, true)
from inventory_parts_asset_id_seq
cross join (select max(asset_id) as maximum from inventory_parts) restored
where restored.maximum >= last_value;
