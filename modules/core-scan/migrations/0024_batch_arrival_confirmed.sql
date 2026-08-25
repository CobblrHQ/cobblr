-- The USER said the parcel is in hand. The carrier's "delivered" is a claim
-- about a doorstep; this is the only thing that actually finishes the watch
-- (and it is what the notification's button sets).
alter table core_scan_batches
  add column if not exists shipment_confirmed_at timestamptz;
