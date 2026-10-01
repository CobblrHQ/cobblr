-- A task that comes round again: "water the plants every 3 days", "check the
-- smoke alarms every month". When it is done, the next one is made, due one
-- interval later (api/repeat.ts). {every_n, every_unit}, the same calendar
-- rule a service schedule uses; null is a task that happens once.

alter table projects_tasks add column if not exists repeat jsonb default null;
