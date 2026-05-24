// Tenant-side DB types for core-integrations.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface CoreIntegrationsConnectorsTable {
  id: Generated<string>;
  connector_id: string;
  label: string;
  credentials_enc: string;
  config: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreIntegrationsInboundTokensTable {
  id: Generated<string>;
  connector_id: string;
  token: string;
  label: string;
  config: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  last_hit_at: Date | null;
  hit_count: Generated<number>;
  created_at: Generated<Date>;
}

export interface CoreIntegrationsCallsTable {
  id: Generated<string>;
  direction: "outbound" | "inbound";
  connector_id: string;
  action_or_event: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  request_meta: unknown | null;
  ms: number | null;
  occurred_at: Generated<Date>;
}

export interface CoreIntegrationsDB {
  core_integrations_connectors: CoreIntegrationsConnectorsTable;
  core_integrations_inbound_tokens: CoreIntegrationsInboundTokensTable;
  core_integrations_calls: CoreIntegrationsCallsTable;
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

export function tenantDb(req: Request): Kysely<CoreIntegrationsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-integrations route called without tenant context");
  return t.db as Kysely<CoreIntegrationsDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-integrations route called without tenant context");
  return { org: t.org, role: t.role };
}
