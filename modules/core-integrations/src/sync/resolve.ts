// Resolve a connection's sync connector: a GLOBAL built-in OR one of THIS
// workspace's installed declarative manifests. Shared by the HTTP surface
// (api/sync.ts) and the live webhook handler (sync/inbound.ts) so both agree —
// nothing source-specific is compiled in. Mirrors digifab's resolveDriver.

import { platform, type SyncConnector } from "@cobblr/platform-contract";
import { type Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { buildSyncConnector } from "./declarative.js";
import { SyncSourceManifest } from "./manifest.js";

export async function installedSyncConnectors(
  db: Kysely<CoreIntegrationsDB>,
): Promise<SyncConnector[]> {
  const rows = await db
    .selectFrom("core_integrations_sync_source_defs")
    .select(["manifest"])
    .where("enabled", "=", true)
    .execute();
  const out: SyncConnector[] = [];
  for (const r of rows) {
    const parsed = SyncSourceManifest.safeParse(r.manifest);
    if (parsed.success) out.push(buildSyncConnector(parsed.data));
  }
  return out;
}

export async function resolveSyncConnector(
  db: Kysely<CoreIntegrationsDB>,
  id: string,
): Promise<SyncConnector | null> {
  return (
    platform().integrations.getSyncConnector(id) ??
    (await installedSyncConnectors(db)).find((c) => c.id === id) ??
    null
  );
}
