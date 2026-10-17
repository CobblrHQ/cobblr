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
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { loadConnectionRef } from "../sync/connection.js";
import { ReconcileBusyError, runReconcile, planReconcile, resolveAsked, runStatusOf, type AskedAnswer } from "../sync/engine.js";
import { archiveConnection, loadSection, setSectionSync, syncNow, testSyncConnection, unarchiveConnection } from "../sync/operations.js";
import { DEFAULT_CADENCE_MIN, ensureSyncScan } from "../sync/worker.js";
import { CONFLICT_POLICIES, type ConflictPolicy } from "@cobblr/platform-contract/sync-merge";
import { optionalField } from "@cobblr/platform-contract/optional-fields";
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
  base_url: z.string().url().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
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
// AI-REACH: exempt — takes an outside service's credentials and mints the
// webhook token for its live pushes; the assistant never handles a secret
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
  label: z.string().min(1).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  base_url: z.string().url().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  credentials: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

// AI-REACH: exempt — replaces the stored credentials and the address they are
// sent to; the assistant never handles a secret or redirects one
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
      set.config = sql`coalesce(config, '{}'::jsonb) || ${JSON.stringify({ base_url: parsed.data.base_url })}::jsonb`;
    }
    if (parsed.data.credentials !== undefined) {
      set.credentials_enc = await platform().integrations.encryptCredentials(ctx.org.id, parsed.data.credentials);
    }
    await db.updateTable("core_integrations_connectors").set(set as never).where("id", "=", req.params.id!).execute();
    res.json({ ok: true });
  }),
);

// AI-REACH: exempt — deletes the stored credentials and the webhook token for
// good; no undo can bring a secret back, so it is the owner's (Archive is the
// reversible door, core-integrations:archive-sync-connection)
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

// ── archive: move a connection to the history section (NOT delete); see
//    archiveConnection. ──
// AI-ACTION: core-integrations:archive-sync-connection
syncRouter.post(
  "/connections/:id/archive",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-integrations:archive-sync-connection"))) return;
    await archiveConnection(tenantDb(req), req.params.id!);
    res.json({ ok: true });
  }),
);

// ── un-archive: one click back to the normal list; sync stays OFF. ──
// AI-ACTION: core-integrations:unarchive-sync-connection
syncRouter.post(
  "/connections/:id/unarchive",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-integrations:unarchive-sync-connection"))) return;
    await unarchiveConnection(tenantDb(req), req.params.id!);
    res.json({ ok: true });
  }),
);

// ── test the connection's credentials ──
// AI-ACTION: core-integrations:test-sync-connection
syncRouter.post(
  "/connections/:id/test",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-integrations:test-sync-connection"))) return;
    const out = await testSyncConnection(tenantDb(req), tenantContext(req).org.id, req.params.id!);
    if (!out.found) return void res.status(404).json({ error: { code: "not_found", message: "connection not found / disabled" } });
    const { found: _found, ...result } = out;
    res.json(result);
  }),
);

const SyncConfig = z.object({
  enabled: z.boolean(),
  cadence_min: z.number().int().min(1).max(1440).optional(),
});

// ── enable/disable live sync + cadence (see setSectionSync) ──
// AI-ACTION: core-integrations:set-sync
syncRouter.put(
  "/connections/:id/syncs/:entityType",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-integrations:set-sync"))) return;
    const parsed = SyncConfig.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    await setSectionSync(tenantDb(req), tenantContext(req).org.id, req.params.id!, req.params.entityType!, parsed.data.enabled, parsed.data.cadence_min);
    res.json({ ok: true });
  }),
);

/** Resolve (ref, type) for a sync sub-route, or send the right 404. */
async function loadRefType(
  req: import("express").Request,
  res: import("express").Response,
): Promise<{ ref: NonNullable<Awaited<ReturnType<typeof loadConnectionRef>>>; type: import("@cobblr/platform-contract").SyncEntityType } | null> {
  const rt = await loadSection(tenantDb(req), tenantContext(req).org.id, req.params.id!, req.params.entityType!);
  if ("error" in rt) {
    res.status(404).json({ error: { code: rt.error, message: rt.error === "not_found" ? rt.message : "entity type not offered by this connector" } });
    return null;
  }
  return rt;
}

// ── import PREVIEW: a dry-run plan (create/update/link/unchanged/delete) that
// writes NOTHING. The "what a manual one-time import would do" view. ──
// AI-REACH: exempt — writes nothing; it is the first half of a person's review
// of a one-time import (the plan they read before they approve it at /import)
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

// ── DRY RUN: the same plan as the preview, as a read. What a run would
// create, link, update or ask about under the section's rule, field by field,
// with nothing written (the source is read, Cobblr is not touched). A GET so a
// read-only look (an operator's view-as, an assistant) can ask it safely. ──
syncRouter.get(
  "/connections/:id/syncs/:entityType/dry-run",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rt = await loadRefType(req, res);
    if (!rt) return;
    try {
      const plan = await planReconcile(tenantDb(req), rt.ref, rt.type);
      res.json({ ok: true, policy: plan.policy, plan });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  }),
);

const PolicyBody = z.object({ conflict_policy: z.enum(CONFLICT_POLICIES as unknown as [ConflictPolicy, ...ConflictPolicy[]]) });

// ── What the section does when the source and Cobblr disagree about a field:
// Cobblr wins (the default) / the source wins / ask. A person's setting. ──
// AI-REACH: exempt — a section's conflict rule is the owner's own setting (it decides whether a sync may write over what a person changed), set on the Integrations page
syncRouter.put(
  "/connections/:id/syncs/:entityType/policy",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = PolicyBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const rt = await loadRefType(req, res);
    if (!rt) return;
    await tenantDb(req)
      .insertInto("core_integrations_sync_state")
      .values({ connector_row_id: rt.ref.connectorRowId, entity_type: rt.type.key, conflict_policy: parsed.data.conflict_policy })
      .onConflict((oc) => oc.columns(["connector_row_id", "entity_type"]).doUpdateSet({ conflict_policy: parsed.data.conflict_policy, updated_at: new Date() }))
      .execute();
    res.json({ ok: true, conflict_policy: parsed.data.conflict_policy });
  }),
);

const ResolveBody = z
  .object({
    external_id: z.string().min(1),
    action: z.enum(["link", "create", "keep", "take"]),
    cobblr_id: optionalField(z.string().min(1)),
    field: optionalField(z.string().min(1)),
  })
  .refine((b) => b.action !== "link" || !!b.cobblr_id, "cobblr_id says which record it is")
  .refine((b) => (b.action !== "keep" && b.action !== "take") || !!b.field, "field says which field");

// ── A person's answer to what a run asked about: a source record is this record
// that is already here (link) or is new (create); a field they differ on is
// kept as Cobblr has it (keep) or taken from the source (take). ──
// AI-REACH: exempt — a person's decision about their own records, listed by the run; nothing is written until they choose
syncRouter.post(
  "/connections/:id/syncs/:entityType/resolve",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const rt = await loadRefType(req, res);
    if (!rt) return;
    try {
      const b = parsed.data;
      const answer: AskedAnswer =
        b.action === "create" ? { action: "create" } : b.action === "link" ? { action: "link", cobblrId: b.cobblr_id! } : { action: b.action, field: b.field! };
      const done = await resolveAsked(tenantDb(req), rt.ref, rt.type, parsed.data.external_id, answer);
      res.json({ ok: true, ...done });
    } catch (e) {
      if (e instanceof ReconcileBusyError) return void res.status(409).json({ ok: false, error: e.message });
      res.status(409).json({ ok: false, error: (e as Error).message });
    }
  }),
);

// ── approve & run the one-time IMPORT (merges by name), then go LIVE. ──
// AI-REACH: exempt — a person's approval of the import plan they just read: a
// bulk write that merges by name into their records, cheap to ask for and
// expensive to get wrong, so it stays a press beside the plan it approves
syncRouter.post(
  "/connections/:id/syncs/:entityType/import",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const rt = await loadRefType(req, res);
    if (!rt) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    try {
      const result = await runReconcile(db, rt.ref, rt.type);
      const now = new Date();
      // The import IS a reconcile, so the poll's next turn is a cadence away.
      // It used to be due NOW: the scan tick that followed re-reconciled what
      // the import had just done, held the sync's lock for it, and a second
      // import pressed seconds later (or the next test in a suite) was told
      // "A sync is already running" (#2880). A 2xx from this route means the
      // connection is free; nothing this route scheduled may contradict that.
      const nextRunAt = new Date(now.getTime() + DEFAULT_CADENCE_MIN * 60_000);
      await db
        .insertInto("core_integrations_sync_state")
        .values({
          connector_row_id: rt.ref.connectorRowId,
          entity_type: rt.type.key,
          enabled: true,
          cadence_min: DEFAULT_CADENCE_MIN,
          import_approved_at: now,
          last_run_at: now,
          ...runStatusOf(result),
          last_synced_count: result.total,
          next_run_at: nextRunAt,
        })
        .onConflict((oc) =>
          oc.columns(["connector_row_id", "entity_type"]).doUpdateSet({
            enabled: true,
            import_approved_at: now, // idempotent — first approval wins, re-import keeps it set
            last_run_at: now,
            ...runStatusOf(result),
            last_synced_count: result.total,
            next_run_at: sql`${nextRunAt}::timestamptz`,
            updated_at: now,
          }),
        )
        .execute();
      await ensureSyncScan(ctx.org.id);
      res.json({ ok: true, result });
    } catch (e) {
      // Somebody (or the poll worker) is already reconciling this sync. That is
      // not a bad gateway and it is not the user's fault: say so and let them
      // press it again. Before the lock this surfaced as a raw duplicate-key
      // 502 from the id-map's unique constraint.
      if (e instanceof ReconcileBusyError) {
        res.status(409).json({ ok: false, error: e.message });
        return;
      }
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  }),
);

// ── sync now: live reconcile (strict external-id; only AFTER import approved) ──
// AI-ACTION: core-integrations:sync-now
syncRouter.post(
  "/connections/:id/syncs/:entityType/run",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-integrations:sync-now"))) return;
    const rt = await loadRefType(req, res);
    if (!rt) return;
    const out = await syncNow(tenantDb(req), rt.ref, rt.type);
    if (out.ok) return void res.json({ ok: true, result: out.result });
    if (out.code === "not_imported") return void res.status(409).json({ error: { code: "not_imported", message: out.message } });
    res.status(out.code === "busy" ? 409 : 502).json({ ok: false, error: out.message });
  }),
);
