-- What actually happened to the last reply we sent a reporter, per channel.
--
-- The resolve endpoint answered a bare `emailed: false`, which reads the same
-- whether the reporter turned email off, has no address, or our sender is down.
-- Storing the per-channel outcome lets the console say which, and keeps saying
-- it after a refresh (the PATCH response is gone by then).
--
-- Additive + nullable: an item replied to before this column existed simply has
-- nothing to show, which is honest.
alter table feedback add column if not exists reply_delivery jsonb;
