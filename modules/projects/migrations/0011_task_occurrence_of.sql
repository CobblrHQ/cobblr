-- Which finished task a repeating task is the next one OF. A repeating chore
-- finished, reopened and finished again made its next chore a second time, and
-- two completions at once made it twice: nothing recorded that the next one
-- already existed. The next one now names the one it came from, and a task has
-- at most one (#7121).

alter table projects_tasks add column if not exists occurrence_of uuid default null;

create unique index if not exists projects_tasks_one_next_occurrence
  on projects_tasks (occurrence_of)
  where occurrence_of is not null;
