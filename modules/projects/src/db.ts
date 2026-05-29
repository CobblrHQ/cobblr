// Kysely table types for projects. Mirrors migrations/0001_init.sql.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export type ProjectStatus = "planning" | "active" | "blocked" | "done" | "abandoned";
export type Priority = "low" | "med" | "high" | "urgent";
export type TaskStatus = "todo" | "doing" | "done" | "blocked" | "cancelled";
export type Energy = "small" | "medium" | "large";

export interface ProjectsProjectsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  status: Generated<ProjectStatus>;
  priority: Priority | null;
  start_date: Date | null;
  target_date: Date | null;
  completion_date: Date | null;
  color: string | null;
  metadata: Generated<Record<string, unknown>>;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProjectsTasksTable {
  id: Generated<string>;
  project_id: string | null;
  title: string;
  description: string | null;
  status: Generated<TaskStatus>;
  priority: Priority | null;
  energy: Energy | null;
  due_date: Date | null;
  completed_at: Date | null;
  order_within: Generated<number>;
  metadata: Generated<Record<string, unknown>>;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProjectsTaskDependenciesTable {
  id: Generated<string>;
  task_id: string;
  depends_on_task_id: string | null;
  target_module: string | null;
  target_entity_type: string | null;
  target_entity_id: string | null;
  satisfied: Generated<boolean>;
  note: string | null;
  instance: Generated<string>;
  created_at: Generated<Date>;
}

export interface ProjectsDB {
  projects_projects: ProjectsProjectsTable;
  projects_tasks: ProjectsTasksTable;
  projects_task_dependencies: ProjectsTaskDependenciesTable;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<ProjectsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("projects route called without tenant context");
  return t.db as Kysely<ProjectsDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("projects route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("projects route called without session");
  return s;
}

/** Instance scope for the request — set by resolveInstance on
 *  /instances/:name/items; falls back to "projects" (the DB column
 *  default) on legacy routes. */
export function instanceOf(req: Request): string {
  return (req as unknown as { instance?: string }).instance ?? "projects";
}
