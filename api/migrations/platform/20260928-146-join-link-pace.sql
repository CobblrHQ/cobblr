-- A join link can say how many may join per day, week, month or year (#3801).
--
-- A wall QR photographed and posted somewhere lets anyone join. A cap on the
-- total ends the link for the club too, and an expiry ends it on a date that
-- has nothing to do with abuse. A pace instead: more joins in the period than
-- allowed PAUSES the link (the admin is told, and resumes it or gives it a new
-- code, which retires the old QR). A paused link lets a member back in and
-- nobody new.
alter table workspace_invites add column if not exists pace_limit integer;
alter table workspace_invites add column if not exists pace_period text;
alter table workspace_invites add constraint workspace_invites_pace_period_check
  check (pace_period is null or pace_period in ('day', 'week', 'month', 'year'));
alter table workspace_invites add column if not exists paused_at timestamptz;
-- Resuming (or a new code) starts the pace afresh: an admin who turns the link
-- back on during a real rush means to let people in, not to have it pause again
-- on the next scan.
alter table workspace_invites add column if not exists pace_since timestamptz;
