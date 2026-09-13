-- Which way round a receipt session's numeric date was read (#2917).
-- date_convention: mdy | dmy (null when the printed date needed no reading,
-- or the read had no text to work from). date_decided_by: unambiguous |
-- receipt | workspace | nearest-past | model (receipt-date.ts). date_printed:
-- the date as it appeared on the receipt. Recorded so a wrong reading is a
-- fact a person can see, and so later receipts in the workspace inherit the
-- convention its earlier ones established.
alter table core_scan_batches
  add column if not exists date_convention text,
  add column if not exists date_decided_by text,
  add column if not exists date_printed    text;
