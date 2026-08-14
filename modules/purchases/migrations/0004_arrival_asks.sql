-- Which orders we have already asked about, so the arrival sweep asks once
-- rather than every day.
--
-- The sweep runs hourly and a due order stays due until somebody answers, so
-- without a ledger it would re-notify on every tick. A prompt that repeats
-- itself is one people learn to dismiss on sight, which costs more than never
-- having asked.
--
-- Keyed on the order with the ETA we asked ABOUT: re-dating an order (the
-- seller pushed delivery back) is a new question and resets the count, while
-- an unchanged date never asks a third time.

create table purchases_arrival_asks (
  order_id          uuid primary key references purchases_orders(id) on delete cascade,
  -- The expected_arrival this ask was about. Differs from the order's current
  -- value exactly when the date moved, which is what re-opens the question.
  expected_arrival  date        not null,
  asks              integer     not null default 1,
  first_asked_at    timestamptz not null default now(),
  last_asked_at     timestamptz not null default now()
);
