// Kysely table types for projects. Mirrors migrations/0001_init.sql.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { requestInstance } from "@cobblr/platform-contract/request-instance";

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

export interface ProjectsPatternPhotosTable {
  design_id: string;
  pattern_file_id: string;
  extracted: Generated<number>;
  hero_index: number | null;
  used_index: number | null;
  photo_file_id: string | null;
  attachment_id: string | null;
  error: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProjectsPatternPhotoCandidatesTable {
  design_id: string;
  pattern_file_id: string;
  idx: number;
  page: number;
  width: number;
  height: number;
  photo: boolean;
  metrics: Generated<Record<string, unknown>>;
  thumb: Buffer;
}

export type PatternNeedKind = "yarn" | "hook" | "needle" | "notion";
export type PatternNeedSource = "pattern" | "ai" | "hand";

export interface ProjectsPatternNeedsTable {
  id: Generated<string>;
  project_id: string;
  kind: PatternNeedKind;
  position: Generated<number>;
  label: string | null;
  brand: string | null;
  product: string | null;
  color: string | null;
  color_code: string | null;
  weight: string | null;
  fiber: string | null;
  quantity: string | number | null;
  quantity_unit: string | null;
  unit_length_m: string | number | null;
  length_m: string | number | null;
  length_choices: { label: string; unit_length_m: number }[] | null;
  size_mm: string | number | null;
  size_label: string | null;
  source: Generated<PatternNeedSource>;
  pattern_file_id: string | null;
  edited: Generated<boolean>;
  part_id: string | null;
  list_item_id: string | null;
  settled_at: Date | null;
  settle_note: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProjectsPatternReadsTable {
  project_id: string;
  pattern_file_id: string;
  status: "ready" | "empty" | "failed";
  method: "pattern" | "ai" | null;
  ai_tried: Generated<boolean>;
  reason: string | null;
  read_at: Generated<Date>;
}

/** A pattern's words, for search: the text of its latest pattern PDF.
 *  `pending` = made before the text was kept; the heal reads it. */
export interface ProjectsPatternTextsTable {
  project_id: string;
  pattern_file_id: string | null;
  text: string | null;
  pending: Generated<boolean>;
  indexed_at: Generated<Date>;
}

export interface ProjectsDB {
  projects_projects: ProjectsProjectsTable;
  projects_tasks: ProjectsTasksTable;
  projects_task_dependencies: ProjectsTaskDependenciesTable;
  projects_pattern_photos: ProjectsPatternPhotosTable;
  projects_pattern_photo_candidates: ProjectsPatternPhotoCandidatesTable;
  projects_pattern_needs: ProjectsPatternNeedsTable;
  projects_pattern_reads: ProjectsPatternReadsTable;
  projects_pattern_texts: ProjectsPatternTextsTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

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
  return requestInstance(req, "projects");
}
