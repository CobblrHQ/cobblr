// /api/v1/orgs/:slug/modules/digifab/failure — AI print-failure detection config
// + status + a manual "check now". The watch loop itself lives in
// ../failure-detect.ts; this is its HTTP surface.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { readFailureConfig, detectOnce, ewmUpdate, crossed } from "../failure-detect.js";
import type { DetectorManifest } from "../detectors/manifest.js";
import { detectorCatalog, resolveDetector } from "../detectors/registry.js";
import {
  testDetectorManifest,
  listDetectorCameras,
  listDetectorProviders,
  createDetectorPrinter,
  createDetectorMonitor,
  listDetectorPrinters,
  buildMirrorConfig,
  type MirrorContext,
} from "../detectors/engine.js";
import { assertSafeMachineUrl } from "../drivers/ssrf.js";
import { parseBambuLan } from "../jobs-core.js";

export const failureRouter = Router({ mergeParams: true });

// ── config (singleton) ───────────────────────────────────────────────────────
failureRouter.get(
  "/config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json(await readFailureConfig(tenantDb(req)));
  }),
);

const ConfigBody = z.object({
  enabled: z.boolean().optional(),
  threshold: z.number().min(0.1).max(0.99).optional(),
  sample_interval_sec: z.number().int().min(5).max(600).optional(),
  auto_pause: z.boolean().optional(),
  backend: z.enum(["auto", "edge", "llm", "detector"]).optional(),
  detector_id: z.string().uuid().nullable().optional(),
});
failureRouter.put(
  "/config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "invalid failure-detection config" } });
    const db = tenantDb(req);
    const patch = { ...parsed.data, updated_at: new Date() };
    await db
      .insertInto("digifab_failure_config")
      .values({ id: true, ...patch })
      .onConflict((oc) => oc.column("id").doUpdateSet(patch))
      .execute();
    res.json(await readFailureConfig(db));
  }),
);

// ── per-device watch status (for the fleet card) ─────────────────────────────
failureRouter.get(
  "/:connectionId/:deviceId/status",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const row = await tenantDb(req)
      .selectFrom("digifab_failure_watch")
      .select(["score", "samples", "last_probability", "last_source", "paused_at", "last_sample_at", "watch_at"])
      .where("connection_id", "=", req.params.connectionId!)
      .where("device_id", "=", req.params.deviceId!)
      .executeTakeFirst();
    res.json({
      watching: !!row?.watch_at,
      score: row ? Number(row.score) : 0,
      samples: row ? Number(row.samples) : 0,
      last_probability: row?.last_probability ?? null,
      last_source: row?.last_source ?? null,
      paused: !!row?.paused_at,
      paused_at: row?.paused_at ?? null,
      last_sample_at: row?.last_sample_at ?? null,
    });
  }),
);

// ── manual "check now" — one sample, no state change ─────────────────────────
failureRouter.post(
  "/:connectionId/:deviceId/check",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const cfg = await readFailureConfig(db);
    const r = await detectOnce(db, orgId, req.params.connectionId!, req.params.deviceId!, cfg);
    if (!r) return void res.status(200).json({ available: false, reason: "no reading (no camera frame, or no model / AI provider)" });
    // Show how this single reading would move a fresh score against the threshold.
    const projected = ewmUpdate(0, r.probability);
    res.json({ available: true, probability: r.probability, source: r.source, would_trip: crossed(r.probability, cfg.threshold), projected_score: projected });
  }),
);

// ── external detectors (Obico ML API, PrintGuard, generic LAN box) ────────────

/** The detector packages an operator can point at a base URL (the UI picker). */
failureRouter.get(
  "/detectors/catalog",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json({ detectors: detectorCatalog() });
  }),
);

/** List the workspace's configured detectors (never returns credentials). */
failureRouter.get(
  "/detectors",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rows = await tenantDb(req)
      .selectFrom("digifab_detectors")
      .select(["id", "key", "label", "base_url", "config", "enabled", "credentials_enc", "created_at", "updated_at"])
      .orderBy("created_at", "asc")
      .execute();
    res.json({
      detectors: rows.map((r) => ({
        id: r.id,
        key: r.key,
        label: r.label,
        base_url: r.base_url,
        config: r.config,
        enabled: r.enabled,
        has_credentials: !!r.credentials_enc,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  }),
);

const DetectorBody = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  base_url: z.string().min(1).max(500),
  api_key: z.string().max(4000).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

async function safeBaseUrl(res: import("express").Response, url: string): Promise<boolean> {
  try {
    await assertSafeMachineUrl(url);
    return true;
  } catch (e) {
    res.status(400).json({ error: { code: "unsafe_url", message: (e as Error).message } });
    return false;
  }
}

/** Create a detector. `key` must be a known external detector package. */
failureRouter.post(
  "/detectors",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = DetectorBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "invalid detector" } });
    const pkg = resolveDetector(parsed.data.key);
    if (!pkg?.external || !pkg.manifest) return void res.status(400).json({ error: { code: "unknown_detector", message: `no external detector "${parsed.data.key}"` } });
    if (!(await safeBaseUrl(res, parsed.data.base_url))) return;
    const orgId = tenantContext(req).org.id;
    const credentials_enc = parsed.data.api_key
      ? await platform().integrations.encryptCredentials(orgId, { apiKey: parsed.data.api_key })
      : null;
    const row = await tenantDb(req)
      .insertInto("digifab_detectors")
      .values({
        key: parsed.data.key,
        label: parsed.data.label,
        base_url: parsed.data.base_url,
        credentials_enc,
        config: (parsed.data.config ?? {}) as never,
        enabled: parsed.data.enabled ?? true,
      })
      .returning(["id", "key", "label", "base_url", "config", "enabled"])
      .executeTakeFirstOrThrow();
    res.status(201).json({ ...row, has_credentials: !!credentials_enc });
  }),
);

const DetectorPatch = z.object({
  label: z.string().min(1).max(120).optional(),
  base_url: z.string().min(1).max(500).optional(),
  api_key: z.string().max(4000).nullable().optional(), // null clears the token
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

failureRouter.patch(
  "/detectors/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = DetectorPatch.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "invalid detector patch" } });
    if (parsed.data.base_url !== undefined && !(await safeBaseUrl(res, parsed.data.base_url))) return;
    const orgId = tenantContext(req).org.id;
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.base_url !== undefined) patch.base_url = parsed.data.base_url;
    if (parsed.data.config !== undefined) patch.config = parsed.data.config;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.api_key !== undefined) {
      patch.credentials_enc = parsed.data.api_key ? await platform().integrations.encryptCredentials(orgId, { apiKey: parsed.data.api_key }) : null;
    }
    const row = await tenantDb(req)
      .updateTable("digifab_detectors")
      .set(patch as never)
      .where("id", "=", req.params.id!)
      .returning(["id", "key", "label", "base_url", "config", "enabled", "credentials_enc"])
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "detector not found" } });
    res.json({ id: row.id, key: row.key, label: row.label, base_url: row.base_url, config: row.config, enabled: row.enabled, has_credentials: !!row.credentials_enc });
  }),
);

failureRouter.delete(
  "/detectors/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const r = await tenantDb(req).deleteFrom("digifab_detectors").where("id", "=", req.params.id!).executeTakeFirst();
    // If this detector was the selected one, unstick the config so the watch
    // doesn't dangle on a missing row.
    await tenantDb(req).updateTable("digifab_failure_config").set({ detector_id: null }).where("detector_id", "=", req.params.id!).execute();
    if (!Number(r.numDeletedRows ?? 0)) return void res.status(404).json({ error: { code: "not_found", message: "detector not found" } });
    res.json({ ok: true });
  }),
);

/** Import list — the detector service's own cameras, for the link picker. */
failureRouter.get(
  "/detectors/:id/cameras",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const row = await tenantDb(req)
      .selectFrom("digifab_detectors")
      .select(["key", "base_url", "credentials_enc"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "detector not found" } });
    const pkg = resolveDetector(row.key);
    if (!pkg?.manifest?.listCameras) return void res.status(400).json({ error: { code: "unsupported", message: "this detector can't list cameras" } });
    let apiKey: string | null = null;
    if (row.credentials_enc) {
      try {
        const creds = await platform().integrations.decryptCredentials(tenantContext(req).org.id, row.credentials_enc);
        apiKey = (creds.apiKey as string | undefined) ?? null;
      } catch {
        /* undecryptable → try without auth */
      }
    }
    try {
      const cameras = await listDetectorCameras(pkg.manifest, { baseUrl: row.base_url, apiKey });
      res.json({ cameras });
    } catch (e) {
      res.status(502).json({ error: { code: "unreachable", message: (e as Error).message } });
    }
  }),
);

/** Load a detector row → its package + a live connection (decrypts the token). */
async function detectorConn(db: ReturnType<typeof tenantDb>, orgId: string, id: string) {
  const row = await db.selectFrom("digifab_detectors").select(["key", "base_url", "credentials_enc"]).where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const pkg = resolveDetector(row.key);
  if (!pkg?.manifest) return null;
  let apiKey: string | null = null;
  if (row.credentials_enc) {
    try {
      const creds = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
      apiKey = (creds.apiKey as string | undefined) ?? null;
    } catch {
      /* undecryptable → try without auth */
    }
  }
  return { manifest: pkg.manifest, conn: { baseUrl: row.base_url, apiKey } };
}

/** Register a printer, then bind its auto-registered camera to a new monitor so
 *  the service actually watches (unless watch=false). */
async function registerPrinterFlow(
  m: DetectorManifest,
  conn: { baseUrl: string; apiKey: string | null },
  input: { name: string; provider: string; config: Record<string, unknown>; watch?: boolean },
): Promise<{ printer_id: string | null; camera_id: string | null; monitor: boolean }> {
  const before = new Set((await listDetectorPrinters(m, conn)).map((p) => p.id));
  await createDetectorPrinter(m, conn, { name: input.name, provider: input.provider, config: input.config });
  const created = (await listDetectorPrinters(m, conn)).find((p) => !before.has(p.id)) ?? null;
  let camera_id: string | null = null;
  let monitor = false;
  if (created && input.watch !== false && m.createMonitor && m.listCameras) {
    const cam = (await listDetectorCameras(m, conn)).find((c) => c.printerId === created.id);
    if (cam) {
      await createDetectorMonitor(m, conn, { camera_id: cam.id, printer_id: created.id });
      camera_id = cam.id;
      monitor = true;
    }
  }
  return { printer_id: created?.id ?? null, camera_id, monitor };
}

/** The per-printer creds for a `perDevice` mapping — the one bit that knows a
 *  Cobblr connection type's own credential SHAPE (Bambu stores serial→{host,
 *  access_code}); the field MAPPING itself stays generic in the manifest.
 *  Returns the `device` context, or null if no per-device creds are stored. */
function perDeviceCreds(connType: string, creds: Record<string, unknown>, deviceId: string): Record<string, string> | null {
  if (connType === "bambu") {
    const lan = parseBambuLan(creds)[deviceId];
    if (!lan?.host || !lan?.access_code) return null; // cloud-only Bambu → nothing to mirror
    return { serial: deviceId, host: lan.host, access_code: lan.access_code };
  }
  return null;
}

/** The provider types (+ config schemas) a printer can be registered under, plus
 *  the connection-mirror mappings (which Cobblr connection types map, + which are
 *  per-printer). Mappings are local manifest data, so they return even if the
 *  service is unreachable. */
failureRouter.get(
  "/detectors/:id/providers",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const d = await detectorConn(tenantDb(req), tenantContext(req).org.id, req.params.id!);
    if (!d) return void res.status(404).json({ error: { code: "not_found", message: "detector not found" } });
    if (!d.manifest.listProviders) return void res.status(400).json({ error: { code: "unsupported", message: "this detector can't register printers" } });
    const mappings = (d.manifest.connectionMappings ?? []).map((m) => ({ from: m.from, provider: m.provider, perDevice: !!m.perDevice }));
    try {
      res.json({ providers: await listDetectorProviders(d.manifest, d.conn), mappings });
    } catch (e) {
      // The service is unreachable, but the mirror mappings are still usable.
      res.json({ providers: [], mappings, error: (e as Error).message });
    }
  }),
);

const RegisterPrinterBody = z.object({
  name: z.string().min(1).max(120),
  provider: z.string().min(1).max(64),
  config: z.record(z.unknown()),
  /** Also bind a monitor so the service actually watches (default true). */
  watch: z.boolean().optional(),
});

/** Register a printer in the detector service (which auto-registers its webcam),
 *  then optionally bind a monitor so it watches — the "Add to PrintGuard" flow. */
failureRouter.post(
  "/detectors/:id/printers",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = RegisterPrinterBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "invalid printer" } });
    const d = await detectorConn(tenantDb(req), tenantContext(req).org.id, req.params.id!);
    if (!d) return void res.status(404).json({ error: { code: "not_found", message: "detector not found" } });
    if (!d.manifest.createPrinter) return void res.status(400).json({ error: { code: "unsupported", message: "this detector can't register printers" } });
    try {
      const out = await registerPrinterFlow(d.manifest, d.conn, parsed.data);
      res.status(201).json({ ok: true, ...out });
    } catch (e) {
      res.status(502).json({ error: { code: "register_failed", message: (e as Error).message } });
    }
  }),
);

const MirrorBody = z.object({
  connection_id: z.string().min(1),
  /** Which printer within the connection (required for perDevice types, e.g. Bambu's serial). */
  device_id: z.string().optional(),
  name: z.string().max(120).optional(),
  watch: z.boolean().optional(),
  /** After mirroring, disable Cobblr's own connection so it stops polling the
   *  printer (the detector owns it now). Only for single-printer connections —
   *  ignored for perDevice types, which may hold other printers Cobblr still runs. */
  disable_source: z.boolean().optional(),
});

/** "Add THIS printer to the detector": mirror an existing Cobblr connection into
 *  the detector using the manifest's connectionMappings — the credential stays
 *  server-side (never sent to the client). Generic: any connection type with a
 *  mapping works; perDevice types (Bambu) need a device_id. */
failureRouter.post(
  "/detectors/:id/printers/from-connection",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = MirrorBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "invalid request" } });
    const orgId = tenantContext(req).org.id;
    const d = await detectorConn(tenantDb(req), orgId, req.params.id!);
    if (!d) return void res.status(404).json({ error: { code: "not_found", message: "detector not found" } });
    if (!d.manifest.createPrinter) return void res.status(400).json({ error: { code: "unsupported", message: "this detector can't register printers" } });
    const c = await platform().devices.connections().getInternal(orgId, parsed.data.connection_id);
    if (!c) return void res.status(404).json({ error: { code: "not_found", message: "connection not found" } });
    const mapping = d.manifest.connectionMappings?.find((m) => m.from === c.type);
    if (!mapping) return void res.status(400).json({ error: { code: "unmappable", message: `no mapping for a "${c.type}" connection — use the form` } });

    let creds: Record<string, unknown> = {};
    if (c.credentials_enc) {
      try {
        creds = await platform().integrations.decryptCredentials(orgId, c.credentials_enc);
      } catch {
        /* leave blank — the service rejects if it needs a credential */
      }
    }
    const ctx: MirrorContext = {
      base_url: c.base_url,
      apiKey: (creds.apiKey as string | undefined) ?? "",
      username: (creds.username as string | undefined) ?? "",
      password: (creds.password as string | undefined) ?? "",
    };
    if (mapping.perDevice) {
      if (!parsed.data.device_id) return void res.status(400).json({ error: { code: "device_required", message: "pick which printer on this connection" } });
      const device = perDeviceCreds(c.type, creds, parsed.data.device_id);
      if (!device) return void res.status(400).json({ error: { code: "no_lan_creds", message: `no LAN access stored for that printer. Add its host + access code in Cobblr first` } });
      ctx.device = device;
    }
    try {
      const out = await registerPrinterFlow(d.manifest, d.conn, {
        name: parsed.data.name || parsed.data.device_id || `${mapping.provider} printer`,
        provider: mapping.provider,
        config: buildMirrorConfig(mapping.config, ctx),
        watch: parsed.data.watch,
      });
      // Enforce single-owner: stop Cobblr polling the printer it just handed over.
      // The fleet fully skips a disabled connection (no listDevices, camera, or
      // assign). Only for single-printer connections — a perDevice connection may
      // hold sibling printers Cobblr still manages.
      let source_disabled = false;
      if (parsed.data.disable_source && !mapping.perDevice) {
        await platform().devices.connections().update(orgId, parsed.data.connection_id, { enabled: false });
        void platform().events.emit("digifab.connection.updated", { orgId, rowId: parsed.data.connection_id });
        source_disabled = true;
      }
      res.status(201).json({ ok: true, ...out, source_disabled });
    } catch (e) {
      res.status(502).json({ error: { code: "register_failed", message: (e as Error).message } });
    }
  }),
);

/** The detector service's printers with live print state (for Cobblr to consume
 *  when the service owns the printer). */
failureRouter.get(
  "/detectors/:id/printers",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const d = await detectorConn(tenantDb(req), tenantContext(req).org.id, req.params.id!);
    if (!d) return void res.status(404).json({ error: { code: "not_found", message: "detector not found" } });
    if (!d.manifest.listPrinters) return void res.status(400).json({ error: { code: "unsupported", message: "this detector can't list printers" } });
    try {
      res.json({ printers: await listDetectorPrinters(d.manifest, d.conn) });
    } catch (e) {
      res.status(502).json({ error: { code: "unreachable", message: (e as Error).message } });
    }
  }),
);

/** Reachability check — hit the detector's health endpoint (or its base URL). */
failureRouter.post(
  "/detectors/:id/test",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const row = await tenantDb(req)
      .selectFrom("digifab_detectors")
      .select(["key", "base_url", "credentials_enc"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "detector not found" } });
    const pkg = resolveDetector(row.key);
    if (!pkg?.manifest) return void res.status(400).json({ error: { code: "unknown_detector", message: `detector package "${row.key}" is not wired` } });
    let apiKey: string | null = null;
    if (row.credentials_enc) {
      try {
        const creds = await platform().integrations.decryptCredentials(tenantContext(req).org.id, row.credentials_enc);
        apiKey = (creds.apiKey as string | undefined) ?? null;
      } catch {
        /* undecryptable → test without auth */
      }
    }
    res.json(await testDetectorManifest(pkg.manifest, row.base_url, apiKey));
  }),
);
