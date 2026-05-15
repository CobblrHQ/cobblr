-- Projects module — tenant-side schema.
--
-- Project = container concept (state, dates, target). Task = unit
-- of work with its own state machine. A task can belong to a
-- project (project_id nullable so standalone tasks work).
--
-- Task dependencies are polymorphic: a task can depend on another
-- task, OR on an entity in another module (e.g. an inventory part
-- being in stock). Cross-module dependencies use the same
-- (target_module, target_entity_type, target_entity_id) tuple
-- pattern as inventory's allocations. The 'satisfied' flag is the
-- denormalised resolution state — when external events fire
-- (inventory.stock.changed, etc.) we flip the flag.

create extension if not exists "pgcrypto";

create table projects_projects (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  status          text not null default 'active'
                    check (status in ('planning', 'active', 'blocked', 'done', 'abandoned')),
  priority        text default 'med'
                    check (priority is null or priority in ('low', 'med', 'high', 'urgent')),
  start_date      date,
  target_date     date,
  completion_date date,
  color           text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index projects_projects_status_idx on projects_projects(status);

create table projects_tasks (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid references projects_projects(id) on delete set null,
  title           text not null,
  description     text,
  status          text not null default 'todo'
                    check (status in ('todo', 'doing', 'done', 'blocked', 'cancelled')),
  priority        text default 'med'
                    check (priority is null or priority in ('low', 'med', 'high', 'urgent')),
  energy          text default 'medium'
                    check (energy is null or energy in ('small', 'medium', 'large')),
  due_date        timestamptz,
  completed_at    timestamptz,
  order_within    integer not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index projects_tasks_project_idx on projects_tasks(project_id);
create index projects_tasks_status_idx on projects_tasks(status);
create index projects_tasks_due_idx on projects_tasks(due_date) where due_date is not null;

-- Task dependencies. depends_on_task_id covers same-module
-- dependencies; the (target_module, target_entity_type,
-- target_entity_id) trio covers cross-module ones. Exactly one
-- branch is set per row — enforced by a CHECK so dirty data can't
-- creep in.
create table projects_task_dependencies (
  id                    uuid primary key default gen_random_uuid(),
  task_id               uuid not null references projects_tasks(id) on delete cascade,
  depends_on_task_id    uuid references projects_tasks(id) on delete cascade,
  target_module         text,
  target_entity_type    text,
  target_entity_id      text,
  satisfied             boolean not null default false,
  note                  text,
  created_at            timestamptz not null default now(),
  check (
    (depends_on_task_id is not null and target_module is null)
    or
    (depends_on_task_id is null and target_module is not null
      and target_entity_type is not null and target_entity_id is not null)
  )
);

create index projects_task_deps_task_idx on projects_task_dependencies(task_id);
create index projects_task_deps_target_idx
  on projects_task_dependencies(target_module, target_entity_type, target_entity_id)
  where target_module is not null;
create index projects_task_deps_satisfied_idx
  on projects_task_dependencies(satisfied) where not satisfied;
