// The live push path: ONE inbound handler for all sync connectors.
//
// The connection's inbound webhook token carries { connector_row_id,
// connector_id } in its config. On a POST, we resolve the connection, hand the
// body to the connector's parseWebhook, and run applyWebhookHit through the
// SAME engine the reconcile poll uses — so the two paths are convergent.

import { platform } from "@cobblr/platform-contract";
import { type Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { applyWebhookHit } from "./engine.js";
import { loadConnectionRef } from "./connection.js";

let registered = false;

export function registerSyncInboundHandler(): void {
  if (registered) return;
  registered = true;

  platform().integrations.registerInboundHandler({
    id: "sync",
    label: "Data sync (live push)",
    describeWebhookConfig: () => ({}),
    emits: ["core-integrations.sync.received"],
    async handle(req, ctx) {
      const cfg = ctx.config as { connector_row_id?: string; connector_id?: string };
      if (!cfg.connector_row_id || !cfg.connector_id) {
        return { status: 400, body: { error: "not a sync webhook token" } };
      }
      const connector = platform().integrations.getSyncConnector(cfg.connector_id);
      if (!connector?.parseWebhook) {
        return { status: 202, body: { ok: true, ignored: "connector has no webhook parser" } };
      }
      const hit = connector.parseWebhook(req.body, req.headers);
      if (!hit) return { status: 202, body: { ok: true, ignored: true } };

      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreIntegrationsDB>;
      const ref = await loadConnectionRef(db, ctx.orgId, cfg.connector_row_id);
      if (!ref) return { status: 404, body: { error: "sync connection not found / disabled" } };

      // Live webhook only writes once this entity type's first import is approved
      // and live sync is on — otherwise a push would bypass the preview gate.
      const state = await db
        .selectFrom("core_integrations_sync_state")
        .select(["enabled", "import_approved_at"])
        .where("connector_row_id", "=", cfg.connector_row_id)
        .where("entity_type", "=", hit.entityType)
        .executeTakeFirst();
      if (!state?.import_approved_at || !state.enabled) {
        return { status: 202, body: { ok: true, ignored: "entity type not live (preview pending or disabled)" } };
      }

      try {
        await applyWebhookHit(db, ref, connector, hit);
      } catch (e) {
        return { status: 500, body: { error: (e as Error).message } };
      }
      await ctx.emit("core-integrations.sync.received", {
        entityType: hit.entityType,
        externalId: hit.externalId,
        deleted: !!hit.deleted,
      });
      return { status: 200, body: { ok: true } };
    },
  });
}
