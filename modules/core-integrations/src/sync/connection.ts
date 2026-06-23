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
  if (!row || !row.enabled) return null;
  const credentials = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
  const config = (row.config ?? {}) as {
    base_url?: string;
    transport?: "direct" | "edge";
    bridge?: string | null;
  };
  return {
    orgId,
    connectorRowId: row.id,
    connectorId: row.connector_id,
    baseUrl: String(config.base_url ?? ""),
    credentials,
    transport: config.transport === "edge" ? "edge" : "direct",
    bridge: config.bridge ?? null,
  };
}
