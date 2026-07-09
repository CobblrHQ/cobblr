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
  // Archive lifecycle: NULL = in the normal list; set = in the history section
  // (sync off; run/preview 404 until un-archived). See migration 0005.
  archived_at: Date | null;
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

// The id-map for sync connectors: one mirrored Cobblr entity per
// (connection, entity_type, external_id). Both the webhook and the
// reconcile poll upsert through this.
export interface CoreIntegrationsSyncedRecordsTable {
  id: Generated<string>;
  connector_row_id: string;
  entity_type: string;
  target_kind: string;
  external_id: string;
  cobblr_entity_id: string;
  source_hash: string | null;
  deleted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// Per (connection, entity_type) sync enablement + cadence + last-run status.
export interface CoreIntegrationsSyncStateTable {
  connector_row_id: string;
  entity_type: string;
  enabled: Generated<boolean>;
  cadence_min: Generated<number>;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  last_synced_count: number | null;
  next_run_at: Date | null;
  /** Null until the first import is approved — live poll + webhook are withheld
   *  while in preview; set once the one-time import runs. */
  import_approved_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// An installed declarative sync-source manifest. `source_id` (= the manifest id)
// is what a connection's connector_id references; the engine resolves a
// connection's connector from the global builtins OR this per-workspace table.
export interface CoreIntegrationsSyncSourceDefsTable {
  id: Generated<string>;
  source_id: string;
  name: string;
  manifest: Record<string, unknown>;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreIntegrationsDB {
  core_integrations_connectors: CoreIntegrationsConnectorsTable;
  core_integrations_inbound_tokens: CoreIntegrationsInboundTokensTable;
  core_integrations_calls: CoreIntegrationsCallsTable;
  core_integrations_synced_records: CoreIntegrationsSyncedRecordsTable;
  core_integrations_sync_state: CoreIntegrationsSyncStateTable;
  core_integrations_sync_source_defs: CoreIntegrationsSyncSourceDefsTable;
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
