-- A receipt session can carry the tracking number for the parcel it describes.
--
-- The number arrives at the same moment as the order number and from the same
-- place -- a person looking at the receipt in the inbox -- so it lives beside
-- order_ref rather than waiting until the receipt has been filed into an order.
--
-- It is also the signal that the purchase has NOT arrived: filing a receipt
-- marks the order 'arrived' by default, which is true of the purchase and false
-- of the delivery. A number here means something is still in transit.
alter table core_scan_batches add column if not exists tracking_number text;
