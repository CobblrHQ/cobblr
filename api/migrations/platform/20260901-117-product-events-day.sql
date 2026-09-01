-- Activation funnel: some product events are DAILY facts ("this person used
-- this workspace today", "this workspace scanned something today"), not
-- occurrences. One row per workspace + user + event + UTC day is enough to
-- answer "did they come back in week two?" and keeps the table sparse under
-- a Live Sort session that fires hundreds of captures.
--
-- `day` is set only by the daily tracker; occurrence rows keep it NULL, so the
-- partial unique index never touches them. Additive: nullable column, partial
-- index, no rewrite.
alter table product_events add column if not exists day date;

create unique index if not exists product_events_daily_uniq
  on product_events (org_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), event, day)
  where day is not null;
