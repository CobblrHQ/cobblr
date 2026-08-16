-- Following a parcel that is still in the inbox.
--
-- A receipt with a tracking number describes something on its way, and that is
-- true whether or not anyone has filed it into a purchase order yet. Filing is
-- a decision about bookkeeping; the parcel moves regardless.
--
-- So the shipment state lives on the batch, the same shape purchases_orders
-- carries it, and the same capability answers for both.
alter table core_scan_batches add column if not exists shipment_state text;
alter table core_scan_batches add column if not exists shipment_description text;
alter table core_scan_batches add column if not exists shipment_location text;
alter table core_scan_batches add column if not exists shipment_checked_at timestamptz;
alter table core_scan_batches add column if not exists shipment_next_poll_at timestamptz;
-- Which state we have already told someone about, so a parcel that stays
-- delivered for a week is announced once rather than every hour.
alter table core_scan_batches add column if not exists shipment_notified_state text;
