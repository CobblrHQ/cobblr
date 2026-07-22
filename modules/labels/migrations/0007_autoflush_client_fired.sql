-- Client-fired auto-flush (slice 3c). A Bluetooth (browser-bluetooth) printer
-- can't be reached from the server, so its accumulate-then-print policy fires in
-- the BROWSER (which holds the BLE handle) instead. This flag marks such a policy:
-- evaluateAutoflush skips server dispatch for it, and the client loop owns the
-- accumulate + n-up compose + BLE fire. Default false = the existing
-- network-printer path is untouched.
alter table labels_autoflush
  add column if not exists client_fired boolean not null default false;
