-- An ask no longer needs a date to have been about.
--
-- A carrier saying "delivered" is a better reason to ask than any estimate, and
-- it can happen before the estimate falls due -- parcels usually arrive early.
-- The ledger's expected_arrival was NOT NULL, which quietly meant only
-- date-driven asks could be recorded, so a carrier-driven one had nowhere to
-- write and the question was never asked at all.
--
-- Loosening a constraint, so every existing reader still holds.

alter table purchases_arrival_asks alter column expected_arrival drop not null;
