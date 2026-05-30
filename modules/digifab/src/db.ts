// Tenant-side DB types + request helpers for digifab.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface DigifabConnectionsTable {
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

export interface DigifabJobsTable {
  id: Generated<string>;
  connection_id: string;
  file_ref: string;
  target_device: string | null;
  target_tag: string | null;
  remote_file_id: string | null;
  remote_job_id: string | null;
  status: Generated<string>;
  progress: number | null;
  error: string | null;
  /** A stored core-files file whose bytes are uploaded at send. */
  file_id: string | null;
  linked_machine_id: string | null;
  linked_task_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_polled_at: Date | null;
}

export interface DigifabDeviceLinksTable {
  id: Generated<string>;
  connection_id: string;
  remote_device_id: string;
  remote_device_name: string | null;
  machine_id: string;
  machine_label: string | null;
  created_at: Generated<Date>;
}

export interface DigifabDriversTable {
  id: Generated<string>;
  /** Driver key — a connection's `type` references this (or a built-in key). */
  key: string;
  name: string;
  /** "declarative" | "edge-adapter". Built-ins (fdm_monster/mock) aren't stored. */
  kind: string;
  /** The manifest (declarative) or { adapterUrl } (edge-adapter). */
  spec: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DigifabDB {
  digifab_connections: DigifabConnectionsTable;
  digifab_jobs: DigifabJobsTable;
  digifab_device_links: DigifabDeviceLinksTable;
  digifab_drivers: DigifabDriversTable;
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

export function tenantDb(req: Request): Kysely<DigifabDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("digifab route called without tenant context");
  return t.db as Kysely<DigifabDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("digifab route called without tenant context");
  return { org: t.org, role: t.role };
}
