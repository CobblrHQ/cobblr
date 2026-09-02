-- The day-of alert. The sweeper already says "expires in 4d" once per
-- (part, date) as soon as a date comes into view; the morning it actually
-- expires there was nothing, because the dedupe row had already been spent.
-- One more column records the day-of notice separately, so each date earns
-- exactly two lines in somebody's list: heads-up, then today.
-- Additive: nullable, no rewrite.
alter table lists_expiry_notifications add column if not exists today_notified_on date;
