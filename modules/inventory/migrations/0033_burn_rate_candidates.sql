create index if not exists inventory_consumption_burn_rate_idx
  on inventory_consumption (at desc)
  where delta::numeric < 0 and kind is distinct from 'correction';
