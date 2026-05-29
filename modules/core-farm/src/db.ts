// Tenant-side DB types + request helpers for core-farm.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface CoreFarmConnectionsTable {
  id: Generated<string>;
  /** Driver type: "fdm_monster" | "mock" | … */
  type: string;
  label: string;
  base_url: string;
  /** AES-GCM ciphertext of { apiKey } — never returned to clients. */
  credentials_enc: string;
  config: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  /** Cached capability probe (e.g. { routing: true }). */
  capabilities: Generated<Record<string, unknown>>;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreFarmJobsTable {
  id: Generated<string>;
  connection_id: string;
  file_ref: string;
  target_printer: string | null;
  target_tag: string | null;
  farm_file_id: string | null;
  farm_job_id: string | null;
  status: Generated<string>;
  progress: number | null;
  error: string | null;
  linked_machine_id: string | null;
  linked_task_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_polled_at: Date | null;
}

export interface CoreFarmDB {
  core_farm_connections: CoreFarmConnectionsTable;
  core_farm_jobs: CoreFarmJobsTable;
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

export function tenantDb(req: Request): Kysely<CoreFarmDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-farm route called without tenant context");
  return t.db as Kysely<CoreFarmDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-farm route called without tenant context");
  return { org: t.org, role: t.role };
}
