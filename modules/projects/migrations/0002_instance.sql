-- Multi-instance support — see docs/design-decisions/instances.md.
--
-- projects has three tables. Tasks are scoped to projects via
-- project_id; task_dependencies are scoped to tasks. The instance
-- column lives on the top-level projects table; tasks + dependencies
-- inherit instance from their parent. Defaults stay so legacy code
-- paths land rows in the default 'projects' instance.

alter table projects_projects
  add column instance text not null default 'projects';
create index projects_projects_instance_idx on projects_projects(instance);

alter table projects_tasks
  add column instance text not null default 'projects';
create index projects_tasks_instance_idx on projects_tasks(instance);

alter table projects_task_dependencies
  add column instance text not null default 'projects';
