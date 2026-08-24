// Tenant-side DB types + request helpers for core-devices.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export interface CoreDevicesLinksTable {
  id: Generated<string>;
  /** The device's connection (today a digifab connection id — logical ref). */
  connection_id: string;
  /** Logical device id on the chip/bridge ("scale", "badge"). */
  device: string;
  /** The Cobblr entity this device feeds ("inventory:part", "assets:asset", …). */
  entity_kind: string;
  entity_id: string;
  /** How a device event maps onto the entity: set | add | log | loan. */
  mode: Generated<string>;
  /** Mode-specific detail, e.g. { field: "stock_qty", unit: "g" }. */
  config: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreDevicesConnectionsTable {
  id: Generated<string>;
  /** Driver type: "fdm_monster" | "mock" | "edge_adapter" | … */
  type: string;
  label: string;
  base_url: string;
  /** AES-GCM ciphertext of { apiKey, … } — never returned to clients. */
  credentials_enc: Generated<string>;
  config: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  capabilities: Generated<Record<string, unknown>>;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreDevicesDB {
  core_devices_links: CoreDevicesLinksTable;
  core_devices_connections: CoreDevicesConnectionsTable;
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

export function tenantDb(req: Request): Kysely<CoreDevicesDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-devices route called without tenant context");
  return t.db as Kysely<CoreDevicesDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-devices route called without tenant context");
  return { org: t.org, role: t.role };
}
