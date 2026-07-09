// Load a sync connection row → a decrypted SyncConnectionRef the engine runs
// against. Shared by the routes (sync-now), the poll worker, and the inbound
// webhook handler.

import { platform } from "@cobblr/platform-contract";
import { type Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import type { SyncConnectionRef } from "./engine.js";

export async function loadConnectionRef(
  db: Kysely<CoreIntegrationsDB>,
  orgId: string,
  connectorRowId: string,
): Promise<SyncConnectionRef | null> {
  const row = await db
    .selectFrom("core_integrations_connectors")
    .selectAll()
    .where("id", "=", connectorRowId)
    .executeTakeFirst();
  // Archived connections are inactive: run/preview/import/test resolve to 404
  // until un-archived (the poll worker already skips them — archive clears
  // sync_state). Un-archive/list/detail read the row directly, not through here.
  if (!row || !row.enabled || row.archived_at) return null;
  const credentials = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
  const config = (row.config ?? {}) as {
    base_url?: string;
    transport?: "direct" | "edge";
    bridge?: string | null;
    target_instances?: Record<string, string>;
  };
  return {
    orgId,
    connectorRowId: row.id,
    connectorId: row.connector_id,
    baseUrl: String(config.base_url ?? ""),
    credentials,
    transport: config.transport === "edge" ? "edge" : "direct",
    bridge: config.bridge ?? null,
    ...(config.target_instances && typeof config.target_instances === "object"
      ? { targetInstances: config.target_instances }
      : {}),
  };
}
