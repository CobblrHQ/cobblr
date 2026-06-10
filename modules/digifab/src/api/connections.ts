// /api/v1/orgs/:slug/modules/digifab/connections —
// CRUD + test + list-printers + resolve. Managing farm connections is
// owner/admin only (they can start/stop machines). API credentials are
// encrypted at write and never returned. Every driver call here is
// read-only except `test` (which only probes) — sending print jobs is a
// separate, explicitly-gated surface (Phase B/C).

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { resolveDriver, availableDriverKeys } from "../drivers/registry.js";
import { assertSafeMachineUrl } from "../drivers/ssrf.js";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import type { MachineDriver } from "../drivers/types.js";

export const connectionsRouter = Router({ mergeParams: true });

const PUBLIC_COLS = [
  "id",
  "type",
  "label",
  "base_url",
  "config",
  "enabled",
  "capabilities",
  "last_sync_at",
  "last_sync_status",
  "created_at",
  "updated_at",
] as const;

// FDM Monster v2 authenticates by login (username+password → JWT) or an
// x-api-key — accept whichever the user has.
const ConnectionCreate = z.object({
  // A driver key — a built-in or an installed driver. Validated against
  // the available set at request time (the enum isn't static anymore).
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

interface ConnRow {
  id: string;
  type: string;
  base_url: string;
  credentials_enc: string;
}

/** Assemble the credentials blob to encrypt from the provided fields. */
function credsFrom(d: { api_key?: string | null; username?: string | null; password?: string | null }): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (d.api_key) c.apiKey = d.api_key;
  if (d.username) c.username = d.username;
  if (d.password) c.password = d.password;
  return c;
}

/** Build a live driver from a connection row (decrypts creds). */
async function buildDriver(db: Kysely<DigifabDB>, orgId: string, row: ConnRow): Promise<MachineDriver> {
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
    },
    row.id,
  );
}

async function loadRow(req: import("express").Request, id: string): Promise<ConnRow | undefined> {
  return (await tenantDb(req)
    .selectFrom("digifab_connections")
    .select(["id", "type", "base_url", "credentials_enc"])
    .where("id", "=", id)
    .executeTakeFirst()) as ConnRow | undefined;
}

connectionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req)
      .selectFrom("digifab_connections")
      .select(PUBLIC_COLS)
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows, types: await availableDriverKeys(tenantDb(req)) });
  }),
);

connectionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConnectionCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    // The driver key must be a built-in or an installed driver.
    if (!(await availableDriverKeys(tenantDb(req))).includes(parsed.data.type)) {
      return void res.status(400).json({ error: { code: "unknown_driver", message: `no driver "${parsed.data.type}" installed` } });
    }
    // SSRF: a connection points the server at a URL — block loopback/metadata.
    // Only police http(s) here; non-http sentinels (mock://) never get fetched.
    if (/^https?:\/\//i.test(parsed.data.base_url)) {
      try {
        await assertSafeMachineUrl(parsed.data.base_url);
      } catch (e) {
        return void res.status(400).json({ error: { code: "unsafe_url", message: (e as Error).message } });
      }
    }
    const creds = credsFrom(parsed.data);
    const enc = Object.keys(creds).length
      ? await platform().integrations.encryptCredentials(ctx.org.id, creds)
      : "";
    const row = await tenantDb(req)
      .insertInto("digifab_connections")
      .values({
        type: parsed.data.type,
        label: parsed.data.label,
        base_url: parsed.data.base_url,
        credentials_enc: enc,
        config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
      })
      .returning(PUBLIC_COLS)
      .executeTakeFirstOrThrow();
    void platform().events.emit("digifab.connection.created", { orgId: ctx.org.id, rowId: (row as { id: string }).id });
    res.status(201).json(row);
  }),
);

connectionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req)
      .selectFrom("digifab_connections")
      .select(PUBLIC_COLS)
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
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
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.label !== undefined) set.label = parsed.data.label;
    if (parsed.data.base_url !== undefined) {
      if (/^https?:\/\//i.test(parsed.data.base_url)) {
        try {
          await assertSafeMachineUrl(parsed.data.base_url);
        } catch (e) {
          return void res.status(400).json({ error: { code: "unsafe_url", message: (e as Error).message } });
        }
      }
      set.base_url = parsed.data.base_url;
    }
    if (parsed.data.enabled !== undefined) set.enabled = parsed.data.enabled;
    if (parsed.data.config !== undefined) set.config = sql`${JSON.stringify(parsed.data.config)}::jsonb`;
    if (
      parsed.data.api_key !== undefined ||
      parsed.data.username !== undefined ||
      parsed.data.password !== undefined
    ) {
      // Merge with existing creds so updating one field (e.g. swapping a
      // login for an api-key) doesn't wipe the others. null clears a field.
      const existing = await tenantDb(req)
        .selectFrom("digifab_connections")
        .select(["credentials_enc"])
        .where("id", "=", req.params.id!)
        .executeTakeFirst();
      const merged: Record<string, unknown> = existing?.credentials_enc
        ? await platform().integrations.decryptCredentials(ctx.org.id, existing.credentials_enc)
        : {};
      const apply = (k: string, v: string | null | undefined) => {
        if (v === null) delete merged[k];
        else if (v !== undefined) merged[k] = v;
      };
      apply("apiKey", parsed.data.api_key);
      apply("username", parsed.data.username);
      apply("password", parsed.data.password);
      set.credentials_enc = Object.keys(merged).length
        ? await platform().integrations.encryptCredentials(ctx.org.id, merged)
        : "";
    }
    const row = await tenantDb(req)
      .updateTable("digifab_connections")
      .set(set as never)
      .where("id", "=", req.params.id!)
      .returning(PUBLIC_COLS)
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    res.json(row);
  }),
);

connectionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    await tenantDb(req).deleteFrom("digifab_connections").where("id", "=", req.params.id!).execute();
    void platform().events.emit("digifab.connection.deleted", { orgId: ctx.org.id, rowId: req.params.id! });
    res.status(204).end();
  }),
);

// ── driver operations ───────────────────────────────────────────────

connectionsRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const row = await loadRow(req, req.params.id!);
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    const driver = await buildDriver(tenantDb(req), ctx.org.id, row);
    const result = await driver.testConnection();
    await tenantDb(req)
      .updateTable("digifab_connections")
      .set({
        capabilities: sql`${JSON.stringify(result.capabilities)}::jsonb` as never,
        last_sync_at: new Date(),
        last_sync_status: result.ok ? "ok" : `error: ${result.detail ?? "unknown"}`.slice(0, 300),
        updated_at: new Date(),
      })
      .where("id", "=", req.params.id!)
      .execute();
    void platform().events.emit("digifab.connection.tested", { orgId: ctx.org.id, rowId: req.params.id!, ok: result.ok });
    res.json(result);
  }),
);

connectionsRouter.get(
  "/:id/printers",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const row = await loadRow(req, req.params.id!);
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    const driver = await buildDriver(tenantDb(req), ctx.org.id, row);
    res.json({ items: await driver.listDevices() });
  }),
);

connectionsRouter.get(
  "/:id/resolve/:fileId",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const row = await loadRow(req, req.params.id!);
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    const driver = await buildDriver(tenantDb(req), ctx.org.id, row);
    res.json(await driver.resolvePlacement(req.params.fileId!));
  }),
);
