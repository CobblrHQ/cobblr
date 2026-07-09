// Sync-connector HTTP surface, mounted at
//   /api/v1/orgs/:slug/modules/core-integrations/sync/...
//
// A sync connection is a core_integrations_connectors row whose connector_id is
// a registered SYNC connector (e.g. "my-shop"). Creating one also mints an
// inbound webhook token (the live push URL). Enabling an entity type writes a
// sync_state row the poll worker scans; "run" reconciles immediately.

import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { platform, type SyncConnector } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { loadConnectionRef } from "../sync/connection.js";
import { runReconcile, planReconcile } from "../sync/engine.js";
import { ensureSyncScan } from "../sync/worker.js";
import { installedSyncConnectors, resolveSyncConnector } from "../sync/resolve.js";

export const syncRouter = Router({ mergeParams: true });

const newToken = (): string => randomBytes(24).toString("base64url");

type TenantDb = ReturnType<typeof tenantDb>;

// resolveSyncConnector / installedSyncConnectors live in ../sync/resolve.js so the
// HTTP surface and the live webhook handler resolve identically (built-in OR this
// workspace's installed manifests — nothing source-specific is compiled in).

// The picker projection (metadata only — no live fns), matching the shape
// platform().integrations.listSyncConnectors() returns for built-ins.
function projectSyncConnector(c: SyncConnector): {
  id: string;
  label: string;
  credentials: Record<string, { label: string; secret: boolean }>;
  config: Record<string, { label: string; placeholder?: string }>;
  entityTypes: Array<{ key: string; label: string; targetKind: string }>;
} {
  return {
    id: c.id,
    label: c.label,
    credentials: c.describeCredentials(),
    config: c.describeConfig?.() ?? {},
    entityTypes: c.entityTypes.map((e) => ({ key: e.key, label: e.label, targetKind: e.targetKind })),
  };
}

/** The "add a connection" catalogue: global built-ins + installed sources. */
async function syncConnectorCatalogue(db: TenantDb) {
  return [
    ...platform().integrations.listSyncConnectors(),
    ...(await installedSyncConnectors(db)).map(projectSyncConnector),
  ];
}

async function syncConnectorIdSet(db: TenantDb): Promise<Set<string>> {
  const installed = await installedSyncConnectors(db);
  return new Set([
    ...platform().integrations.listSyncConnectors().map((c) => c.id),
    ...installed.map((c) => c.id),
  ]);
}

// cobblr_meta lookup so the unauthenticated /api/v1/hooks receiver resolves a
// token without scanning every tenant DB.
function metaLookup(): {
  insertInto: (t: string) => { values: (v: Record<string, unknown>) => { execute: () => Promise<unknown> } };
  deleteFrom: (t: string) => { where: (c: string, op: string, v: unknown) => { execute: () => Promise<unknown> } };
} {
  return platform().db.meta as never;
}

/** Non-secret connection config for the UI (base_url + transport + target
 *  instances, never creds). */
function exposeConfig(config: unknown): {
  base_url: string;
  transport: "direct" | "edge";
  bridge: string | null;
  target_instances: Record<string, string>;
} {
  const c = (config ?? {}) as {
    base_url?: string;
    transport?: "direct" | "edge";
    bridge?: string | null;
    target_instances?: Record<string, string>;
  };
  return {
    base_url: c.base_url ?? "",
    transport: c.transport === "edge" ? "edge" : "direct",
    bridge: c.bridge ?? null,
    target_instances: c.target_instances && typeof c.target_instances === "object" ? c.target_instances : {},
  };
}

// ── catalogue: the "add a connection" picker ──
syncRouter.get(
  "/connectors",
  asyncHandler(async (req, res) => {
    res.json({ items: await syncConnectorCatalogue(tenantDb(req)) });
  }),
);

// ── list this workspace's sync connections + per-type status ──
syncRouter.get(
  "/connections",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const syncIds = await syncConnectorIdSet(db);
    const rows = await db
      .selectFrom("core_integrations_connectors")
      .select(["id", "connector_id", "label", "config", "enabled", "archived_at", "created_at"])
      .execute();
    const conns = rows.filter((r) => syncIds.has(r.connector_id));
    const ids = conns.map((c) => c.id);
    const states = ids.length
      ? await db
          .selectFrom("core_integrations_sync_state")
          .selectAll()
          .where("connector_row_id", "in", ids)
          .execute()
      : [];
    res.json({
      items: conns.map((c) => ({
        ...c,
        config: exposeConfig(c.config), // never leak secrets
        syncs: states.filter((s) => s.connector_row_id === c.id),
      })),
    });
  }),
);

const ConnectionCreate = z.object({
  connector_id: z.string().min(1),
  label: z.string().min(1),
  // Optional: a fixed-baseUrl source (e.g. Ravelry) supplies its own base, so the
  // UI hides the field and this is absent — validated below against the connector.
  base_url: z.string().url().optional(),
  credentials: z.record(z.unknown()).default({}),
  // "edge" routes the source fetch over the workspace's dial-out bridge (the
  // only way a hosted instance reaches a LAN source); "direct" fetches base_url
  // from the cloud (egress-guarded — private targets only on a self-hosted box).
  transport: z.enum(["direct", "edge"]).default("direct"),
  bridge: z.string().max(60).nullable().optional(),
  // Per-connection target-instance override: entity-type key → instance slug.
  // Where the user wants each section's rows to land (their own inventory
  // instance), decoupling a built-in source from any specific bundle.
  target_instances: z.record(z.string().max(60)).optional(),
});

// ── create a connection (+ mint the webhook token) ──
syncRouter.post(
  "/connections",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConnectionCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const def = await resolveSyncConnector(db, parsed.data.connector_id);
    if (!def) {
      return void res.status(400).json({ error: { code: "unknown_connector", message: "not a registered sync connector" } });
    }
    // A connector that exposes a base_url config field needs one entered; a
    // fixed-baseUrl source (describeConfig omits base_url) uses its own.
    const wantsBaseUrl = !!def.describeConfig?.().base_url;
    if (wantsBaseUrl && !parsed.data.base_url) {
      return void res.status(400).json({ error: { code: "missing_base_url", message: "This source needs a base URL." } });
    }
    const enc = await platform().integrations.encryptCredentials(ctx.org.id, parsed.data.credentials);
    const conn = await db
      .insertInto("core_integrations_connectors")
      .values({
        connector_id: parsed.data.connector_id,
        label: parsed.data.label,
        credentials_enc: enc,
        config: sql`${JSON.stringify({ base_url: parsed.data.base_url ?? "", transport: parsed.data.transport, bridge: parsed.data.bridge ?? null, ...(parsed.data.target_instances ? { target_instances: parsed.data.target_instances } : {}) })}::jsonb` as never,
      })
      .returning(["id", "connector_id", "label", "config", "enabled", "created_at"])
      .executeTakeFirstOrThrow();

    // Mint the inbound webhook token (handler id "sync"; config points back at
    // this connection + its connector so the handler can route the push).
    const token = newToken();
    const tokRow = await db
      .insertInto("core_integrations_inbound_tokens")
      .values({
        connector_id: "sync",
        token,
        label: `${parsed.data.label} (sync)`,
        config: sql`${JSON.stringify({ connector_row_id: conn.id, connector_id: parsed.data.connector_id })}::jsonb` as never,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // inbound_id is the inbound-token row id — the receiver loads its config by it.
    await metaLookup()
      .insertInto("integration_inbound_token_lookup")
      .values({ token, org_id: ctx.org.id, inbound_id: tokRow.id, connector_id: "sync", enabled: true })
      .execute();

    void platform().events.emit("core-integrations.connector.created", { orgId: ctx.org.id, connectorId: conn.connector_id });
    res.status(201).json({ ...conn, webhook_path: `/api/v1/integrations/sync/${token}/webhook` });
  }),
);

// ── connection detail (config + per-type status + webhook path) ──
syncRouter.get(
  "/connections/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const conn = await db
      .selectFrom("core_integrations_connectors")
      .select(["id", "connector_id", "label", "config", "enabled", "archived_at", "created_at"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!conn || !(await syncConnectorIdSet(db)).has(conn.connector_id)) {
      return void res.status(404).json({ error: { code: "not_found", message: "sync connection not found" } });
    }
    const states = await db.selectFrom("core_integrations_sync_state").selectAll().where("connector_row_id", "=", conn.id).execute();
    const tok = await db
      .selectFrom("core_integrations_inbound_tokens")
      .select(["token"])
      .where("connector_id", "=", "sync")
      .where(sql`config ->> 'connector_row_id'`, "=", conn.id)
      .executeTakeFirst();
    const def = await resolveSyncConnector(db, conn.connector_id);
    res.json({
      ...conn,
      config: exposeConfig(conn.config),
      entity_types: def?.entityTypes ?? [],
      syncs: states,
      webhook_path: tok ? `/api/v1/integrations/sync/${tok.token}/webhook` : null,
    });
  }),
);

const ConnectionUpdate = z.object({
  label: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  credentials: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

syncRouter.patch(
  "/connections/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConnectionUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.label !== undefined) set.label = parsed.data.label;
    if (parsed.data.enabled !== undefined) set.enabled = parsed.data.enabled;
    if (parsed.data.base_url !== undefined) {
      set.config = sql`${JSON.stringify({ base_url: parsed.data.base_url })}::jsonb`;
    }
    if (parsed.data.credentials !== undefined) {
      set.credentials_enc = await platform().integrations.encryptCredentials(ctx.org.id, parsed.data.credentials);
    }
    await db.updateTable("core_integrations_connectors").set(set as never).where("id", "=", req.params.id!).execute();
    res.json({ ok: true });
  }),
);

syncRouter.delete(
  "/connections/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const id = req.params.id!;
    const tokens = await db
      .selectFrom("core_integrations_inbound_tokens")
      .select(["token"])
      .where("connector_id", "=", "sync")
      .where(sql`config ->> 'connector_row_id'`, "=", id)
      .execute();
    for (const t of tokens) {
      await metaLookup().deleteFrom("integration_inbound_token_lookup").where("token", "=", t.token).execute();
    }
    await db.deleteFrom("core_integrations_inbound_tokens").where("connector_id", "=", "sync").where(sql`config ->> 'connector_row_id'`, "=", id).execute();
    // synced_records + sync_state cascade via FK on the connectors row.
    await db.deleteFrom("core_integrations_connectors").where("id", "=", id).execute();
    res.json({ ok: true });
  }),
);

// ── archive: move a connection to the history section (NOT delete). Turns off
//    ongoing sync so the poll worker drops it; the id-map + config survive, so
//    un-archive resumes it. run/preview/import 404 while archived. ──
syncRouter.post(
  "/connections/:id/archive",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const id = req.params.id!;
    await db.updateTable("core_integrations_connectors").set({ archived_at: new Date(), updated_at: new Date() }).where("id", "=", id).execute();
    // Stop the poll worker: disable every entity-type sync + clear its due-time.
    await db.updateTable("core_integrations_sync_state").set({ enabled: false, next_run_at: null, updated_at: new Date() }).where("connector_row_id", "=", id).execute();
    res.json({ ok: true });
  }),
);

// ── un-archive: one click back to the normal list. Sync stays OFF (archiving is
//    not the same as disabling ongoing sync) — you re-enable it if you want. ──
syncRouter.post(
  "/connections/:id/unarchive",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    await db.updateTable("core_integrations_connectors").set({ archived_at: null, updated_at: new Date() }).where("id", "=", req.params.id!).execute();
    res.json({ ok: true });
  }),
);

// ── test the connection's credentials ──
syncRouter.post(
  "/connections/:id/test",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const ref = await loadConnectionRef(db, ctx.org.id, req.params.id!);
    if (!ref) return void res.status(404).json({ error: { code: "not_found", message: "connection not found / disabled" } });
    const def = await resolveSyncConnector(db, ref.connectorId);
    if (!def?.testConnection) return void res.json({ ok: true, note: "connector has no test" });
    const result = await def.testConnection({ orgId: ref.orgId, baseUrl: ref.baseUrl, credentials: ref.credentials, fetch });
    res.json(result);
  }),
);

const SyncConfig = z.object({
  enabled: z.boolean(),
  cadence_min: z.number().int().min(1).max(1440).optional(),
});

// ── enable/disable live sync + cadence ──
// Live sync only starts once the first import is approved. Before that the row
// stays in PREVIEW (next_run_at null) regardless of the enabled flag.
syncRouter.put(
  "/connections/:id/syncs/:entityType",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = SyncConfig.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const cadence = parsed.data.cadence_min ?? 20;
    const existing = await db
      .selectFrom("core_integrations_sync_state")
      .select(["import_approved_at"])
      .where("connector_row_id", "=", req.params.id!)
      .where("entity_type", "=", req.params.entityType!)
      .executeTakeFirst();
    const approved = !!existing?.import_approved_at;
    const nextRun = parsed.data.enabled && approved ? new Date() : null;
    await db
      .insertInto("core_integrations_sync_state")
      .values({
        connector_row_id: req.params.id!,
        entity_type: req.params.entityType!,
        enabled: parsed.data.enabled,
        cadence_min: cadence,
        next_run_at: nextRun,
      })
      .onConflict((oc) =>
        oc.columns(["connector_row_id", "entity_type"]).doUpdateSet({
          enabled: parsed.data.enabled,
          cadence_min: cadence,
          next_run_at: nextRun,
          updated_at: new Date(),
        }),
      )
      .execute();
    if (parsed.data.enabled && approved) await ensureSyncScan(ctx.org.id);
    res.json({ ok: true });
  }),
);

/** Resolve (ref, type) for a sync sub-route, or send the right 404. */
async function loadRefType(
  req: import("express").Request,
  res: import("express").Response,
): Promise<{ ref: NonNullable<Awaited<ReturnType<typeof loadConnectionRef>>>; type: import("@cobblr/platform-contract").SyncEntityType } | null> {
  const ctx = tenantContext(req);
  const db = tenantDb(req);
  const ref = await loadConnectionRef(db, ctx.org.id, req.params.id!);
  if (!ref) {
    res.status(404).json({ error: { code: "not_found", message: "connection not found / disabled" } });
    return null;
  }
  const def = await resolveSyncConnector(db, ref.connectorId);
  const type = def?.entityTypes.find((t) => t.key === req.params.entityType);
  if (!type) {
    res.status(404).json({ error: { code: "unknown_type", message: "entity type not offered by this connector" } });
    return null;
  }
  return { ref, type };
}

// ── import PREVIEW: a dry-run plan (create/update/link/unchanged/delete) that
// writes NOTHING. The "what a manual one-time import would do" view. ──
syncRouter.post(
  "/connections/:id/syncs/:entityType/preview",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rt = await loadRefType(req, res);
    if (!rt) return;
    try {
      const plan = await planReconcile(tenantDb(req), rt.ref, rt.type);
      res.json({ ok: true, plan });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  }),
);

// ── approve & run the one-time IMPORT (merges by name), then go LIVE. ──
syncRouter.post(
  "/connections/:id/syncs/:entityType/import",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const rt = await loadRefType(req, res);
    if (!rt) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    try {
      const result = await runReconcile(db, rt.ref, rt.type, { linkOnMatch: true });
      const now = new Date();
      await db
        .insertInto("core_integrations_sync_state")
        .values({
          connector_row_id: rt.ref.connectorRowId,
          entity_type: rt.type.key,
          enabled: true,
          cadence_min: 20,
          import_approved_at: now,
          last_run_at: now,
          last_status: "ok",
          last_synced_count: result.total,
          next_run_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["connector_row_id", "entity_type"]).doUpdateSet({
            enabled: true,
            import_approved_at: now, // idempotent — first approval wins, re-import keeps it set
            last_run_at: now,
            last_status: "ok",
            last_error: null,
            last_synced_count: result.total,
            next_run_at: now,
            updated_at: now,
          }),
        )
        .execute();
      await ensureSyncScan(ctx.org.id);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  }),
);

// ── sync now: live reconcile (strict external-id; only AFTER import approved) ──
syncRouter.post(
  "/connections/:id/syncs/:entityType/run",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rt = await loadRefType(req, res);
    if (!rt) return;
    const db = tenantDb(req);
    const state = await db
      .selectFrom("core_integrations_sync_state")
      .select(["import_approved_at"])
      .where("connector_row_id", "=", rt.ref.connectorRowId)
      .where("entity_type", "=", rt.type.key)
      .executeTakeFirst();
    if (!state?.import_approved_at) {
      return void res
        .status(409)
        .json({ error: { code: "not_imported", message: "run the import preview + approve it first" } });
    }
    try {
      const result = await runReconcile(db, rt.ref, rt.type); // live: no name-merge
      await db
        .updateTable("core_integrations_sync_state")
        .set({ last_run_at: new Date(), last_status: "ok", last_error: null, last_synced_count: result.total, updated_at: new Date() })
        .where("connector_row_id", "=", rt.ref.connectorRowId)
        .where("entity_type", "=", rt.type.key)
        .execute();
      res.json({ ok: true, result });
    } catch (e) {
      await db
        .updateTable("core_integrations_sync_state")
        .set({ last_run_at: new Date(), last_status: "error", last_error: (e as Error).message, updated_at: new Date() })
        .where("connector_row_id", "=", rt.ref.connectorRowId)
        .where("entity_type", "=", rt.type.key)
        .execute();
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  }),
);
