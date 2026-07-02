// /api/v1/orgs/:slug/modules/digifab/connections —
// CRUD + test + list-printers + resolve. Managing farm connections is
// owner/admin only. API credentials are encrypted at write and never returned.
//
// The connections TABLE moved to core-devices (the device substrate). This router
// keeps its URL contract (the web is unchanged) but delegates all DATA ops to the
// platform connection store — `platform().devices.connections()` — which owns
// core_devices_connections. The DRIVER ops (test/printers/resolve) stay here: they
// fetch the connection (with creds) from the store and build a driver via digifab's
// registry. See docs/architecture/core-devices-extraction.md §6.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { resolveDriver, availableDriverKeys } from "../drivers/registry.js";
import { buildEdgeRelay, reverseBuildIfCommitted } from "../jobs-core.js";
import { assertSafeMachineUrl } from "../drivers/ssrf.js";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import type { MachineDriver } from "../drivers/types.js";
import type { DeviceConnectionInternal } from "@cobblr/platform-contract";

export const connectionsRouter = Router({ mergeParams: true });

const store = () => platform().devices.connections();

const ConnectionCreate = z.object({
  type: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  base_url: z.string().min(1).max(500),
  api_key: z.string().max(500).optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  config: z.record(z.unknown()).optional(),
});

const ConnectionUpdate = z.object({
  label: z.string().min(1).max(120).optional(),
  base_url: z.string().min(1).max(500).optional(),
  api_key: z.string().max(500).nullable().optional(),
  username: z.string().max(200).nullable().optional(),
  password: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

/** Raw create-creds blob from the provided fields (omit empties). */
function credsFrom(d: { api_key?: string; username?: string; password?: string }): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (d.api_key) c.apiKey = d.api_key;
  if (d.username) c.username = d.username;
  if (d.password) c.password = d.password;
  return c;
}

/** Build a live driver from an internal connection row (decrypts creds). The
 *  digifab db is still needed for the installed-driver (digifab_drivers) lookup. */
async function buildDriver(db: Kysely<DigifabDB>, orgId: string, row: DeviceConnectionInternal): Promise<MachineDriver> {
  let creds: Record<string, unknown> = {};
  if (row.credentials_enc) {
    creds = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
  }
  return resolveDriver(
    db,
    row.type,
    {
      baseUrl: row.base_url,
      apiKey: (creds.apiKey as string | undefined) ?? null,
      username: (creds.username as string | undefined) ?? null,
      password: (creds.password as string | undefined) ?? null,
      extra: { creds },
    },
    row.id,
    // A cobblr-edge:// connection routes through the tunnel here too, so testing
    // it + listing its devices works the moment the bridge is online — not just
    // job send/poll (which already built the relay). Carries the machine config so
    // a dynamic-config bridge configures the driver on the fly.
    buildEdgeRelay(orgId, row.base_url, creds.edge as { driver?: unknown; config?: unknown } | undefined, creds.shared as { owner_org?: unknown } | undefined),
  );
}

async function safeUrl(res: import("express").Response, url: string): Promise<boolean> {
  // Only police http(s); non-http sentinels (mock://) never get fetched.
  if (!/^https?:\/\//i.test(url)) return true;
  try {
    await assertSafeMachineUrl(url);
    return true;
  } catch (e) {
    res.status(400).json({ error: { code: "unsafe_url", message: (e as Error).message } });
    return false;
  }
}

connectionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    // The device-connection store is SHARED across modules (inventory keeps its
    // Spoolman connection here too). Show only connections digifab can drive —
    // its own driver types — so a Spoolman (or other) connection never leaks in.
    const types = await availableDriverKeys(tenantDb(req));
    const driveable = new Set(types);
    const items = (await store().list(ctx.org.id)).filter((c) => driveable.has(c.type));
    res.json({ items, types });
  }),
);

connectionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConnectionCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    if (!(await availableDriverKeys(tenantDb(req))).includes(parsed.data.type)) {
      return void res.status(400).json({ error: { code: "unknown_driver", message: `no driver "${parsed.data.type}" installed` } });
    }
    if (!(await safeUrl(res, parsed.data.base_url))) return;
    // For an edge_adapter machine, the config (driver + host + API key) is what
    // the bridge needs to reach the machine — store it ENCRYPTED in creds (it can
    // hold a printer API key), not the plaintext public config column.
    const isEdge = parsed.data.type === "edge_adapter";
    const row = await store().create(ctx.org.id, {
      type: parsed.data.type,
      label: parsed.data.label,
      base_url: parsed.data.base_url,
      creds: { ...credsFrom(parsed.data), ...(isEdge && parsed.data.config ? { edge: parsed.data.config } : {}) },
      config: isEdge ? undefined : parsed.data.config,
    });
    void platform().events.emit("digifab.connection.created", { orgId: ctx.org.id, rowId: row.id });
    res.status(201).json(row);
  }),
);

connectionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const row = await store().get(ctx.org.id, req.params.id!);
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    res.json(row);
  }),
);

connectionsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConnectionUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    if (parsed.data.base_url !== undefined && !(await safeUrl(res, parsed.data.base_url))) return;
    const existing = await store().get(ctx.org.id, req.params.id!);
    if (!existing) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    const creds: Record<string, unknown> = {};
    if (parsed.data.api_key !== undefined) creds.apiKey = parsed.data.api_key;
    if (parsed.data.username !== undefined) creds.username = parsed.data.username;
    if (parsed.data.password !== undefined) creds.password = parsed.data.password;
    // Mirror the CREATE path for an edge machine: its `config` (driver + host +
    // apiKey) is what rides down the tunnel — it belongs ENCRYPTED in creds.edge.
    // Writing it to the plaintext config column both leaked the printer key and
    // was a silent no-op (the driver-build path only reads creds.edge).
    const isEdge = existing.type === "edge_adapter";
    if (isEdge && parsed.data.config) creds.edge = parsed.data.config;
    const row = await store().update(ctx.org.id, req.params.id!, {
      label: parsed.data.label,
      base_url: parsed.data.base_url,
      enabled: parsed.data.enabled,
      config: isEdge ? undefined : parsed.data.config,
      creds: Object.keys(creds).length ? (creds as Record<string, string | null>) : undefined,
    });
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    void platform().events.emit("digifab.connection.updated", { orgId: ctx.org.id, rowId: row.id });
    res.json(row);
  }),
);

connectionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const id = req.params.id!;
    const db = tenantDb(req);
    // Clean up everything hanging off the connection (the FKs were deliberately
    // dropped in 0008). Orphans weren't cosmetic: a live job kept a dead poll
    // loop, and a pool member pointing at a dead connection made every assign
    // pass build-and-fail a driver forever.
    const live = await db
      .selectFrom("digifab_jobs")
      .select(["id", "status"])
      .where("connection_id", "=", id)
      .where("status", "not in", ["completed", "failed", "cancelled"])
      .execute();
    for (const j of live) {
      await db
        .updateTable("digifab_jobs")
        .set({ status: "cancelled", error: "connection removed", updated_at: new Date() })
        .where("id", "=", j.id)
        .execute();
      await reverseBuildIfCommitted(db, ctx.org.id, j.id, "connection removed");
    }
    await db.deleteFrom("digifab_device_links").where("connection_id", "=", id).execute();
    await db.deleteFrom("digifab_pool_members").where("connection_id", "=", id).execute();
    await db.deleteFrom("digifab_device_attention").where("connection_id", "=", id).execute();
    await db.deleteFrom("digifab_device_settings").where("connection_id", "=", id).execute();
    await db.deleteFrom("digifab_device_snapshots").where("connection_id", "=", id).execute();
    await store().remove(ctx.org.id, id);
    void platform().events.emit("digifab.connection.deleted", { orgId: ctx.org.id, rowId: id });
    res.status(204).end();
  }),
);

// ── driver operations (still here — they build a fabrication driver) ─────────

connectionsRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const row = await store().getInternal(ctx.org.id, req.params.id!);
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    const driver = await buildDriver(tenantDb(req), ctx.org.id, row);
    const result = await driver.testConnection();
    await store().setProbe(
      ctx.org.id,
      row.id,
      result.capabilities as unknown as Record<string, unknown>,
      result.ok ? "ok" : `error: ${result.detail ?? "unknown"}`,
    );
    void platform().events.emit("digifab.connection.tested", { orgId: ctx.org.id, rowId: req.params.id!, ok: result.ok });
    res.json(result);
  }),
);

connectionsRouter.get(
  "/:id/printers",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const row = await store().getInternal(ctx.org.id, req.params.id!);
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    const driver = await buildDriver(tenantDb(req), ctx.org.id, row);
    res.json({ items: await driver.listDevices() });
  }),
);

connectionsRouter.get(
  "/:id/resolve/:fileId",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const row = await store().getInternal(ctx.org.id, req.params.id!);
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    const driver = await buildDriver(tenantDb(req), ctx.org.id, row);
    res.json(await driver.resolvePlacement(req.params.fileId!));
  }),
);
