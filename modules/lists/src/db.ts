// Kysely table types for lists. Column names match the migration
// (snake_case, no @map). Same tenant-context helpers as sibling modules.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface ListsTable {
  id: Generated<string>;
  title: string;
  description: string | null;
  metadata: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ItemsTable {
  id: Generated<string>;
  list_id: string;
  title: string;
  note: string | null;
  qty: string | null;
  checked: Generated<boolean>;
  checked_at: Date | null;
  metadata: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExpiryNotificationsTable {
  part_id: string;
  expires_on: string; // date, read as 'YYYY-MM-DD'
  notified_at: Generated<Date>;
}

export interface ListsDB {
  lists_lists: ListsTable;
  lists_items: ItemsTable;
  lists_expiry_notifications: ExpiryNotificationsTable;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

export interface TenantContext {
  org: { id: string; name: string; slug: string };
  role: OrgRole;
}

interface RequestWithTenant {
  tenant?: { org: { id: string; name: string; slug: string }; role: OrgRole; db: unknown };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<ListsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("lists route called without tenant context");
  return t.db as Kysely<ListsDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("lists route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
