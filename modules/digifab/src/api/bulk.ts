// /api/v1/orgs/:slug/modules/digifab/bulk — stand up a NEW farm fast.
//
// Where import.ts MIGRATES an existing FDM Monster, this is the build-from-
// scratch path: paste a list of controller URLs and Cobblr makes one direct
// connection per printer (matching driver auto-installed), optionally pools
// them, and optionally tests each. Plus a /detect probe so the UI can guess a
// printer's firmware (OctoPrint vs Moonraker vs PrusaLink vs Duet) from its URL.
// Coordinate-not-control throughout — we only read each manager's own API.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { buildDriverById } from "../jobs-core.js";
import { availableDriverKeys } from "../drivers/registry.js";
import { assertSafeMachineUrl } from "../drivers/ssrf.js";
import { detectControllerFirmware, detectPrinterFirmware } from "../firmware-detect.js";
import { ensureDeclarativeDrivers, createPool, addPoolMember } from "./farm-build.js";
import { optionalField, optionalText } from "@cobblr/platform-contract/optional-fields";

export const bulkRouter = Router({ mergeParams: true });

const store = () => platform().devices.connections();

const PrinterRow = z.object({
  name: z.string().max(200).optional(),
  url: z.string().min(1).max(500),
  api_key: z.string().max(500).optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  type: z.string().max(80).optional(), // per-row override of default_type
});

const Body = z.object({
  default_type: z.string().min(1).max(80),
  pool_name: optionalField(z.string().min(1).max(120)), // omit → don't pool
  test: z.boolean().optional(), // probe each after creating
  printers: z.array(PrinterRow).min(1).max(100),
});

function credsFrom(r: z.infer<typeof PrinterRow>): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (r.api_key) c.apiKey = r.api_key;
  if (r.username) c.username = r.username;
  if (r.password) c.password = r.password;
  return c;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// AI-REACH: exempt — saves many managers' credentials at once; the assistant
// never handles a secret
bulkRouter.post(
  "/connections",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    const { default_type, pool_name, test, printers } = parsed.data;

    // Resolve each row's type, then install any catalog drivers they need so
    // the create call below recognises them.
    const rows = printers.map((p) => ({ ...p, type: p.type || default_type }));
    await ensureDeclarativeDrivers(db, rows.map((r) => r.type));
    const known = new Set(await availableDriverKeys(db));

    const poolId = pool_name ? await createPool(db, pool_name) : null;

    const results: Array<{
      index: number; name: string; url: string; type: string;
      status: "created" | "failed"; connection_id?: string; reachable?: boolean; detail?: string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const name = (r.name || "").trim() || hostLabel(r.url);
      const base = { index: i, name, url: r.url, type: r.type };
      try {
        if (!known.has(r.type)) {
          results.push({ ...base, status: "failed", detail: `no driver "${r.type}" installed` });
          continue;
        }
        // SSRF guard (http(s) only; non-http sentinels like mock:// pass through).
        if (/^https?:\/\//i.test(r.url)) await assertSafeMachineUrl(r.url);

        const conn = await store().create(ctx.org.id, {
          type: r.type,
          label: name,
          base_url: r.url,
          creds: credsFrom(r),
        });
        void platform().events.emit("digifab.connection.created", { orgId: ctx.org.id, rowId: conn.id });

        // Probe when asked to test OR when pooling (we need the device list to
        // pool). Best-effort: a created-but-unreachable printer is still added.
        let reachable: boolean | undefined;
        if (test || poolId) {
          try {
            const d = await buildDriverById(db, ctx.org.id, conn.id);
            const devs = d ? await d.listDevices() : [];
            reachable = true;
            if (poolId) for (const dev of devs) await addPoolMember(db, poolId, conn.id, dev.id);
          } catch {
            reachable = false;
          }
        }
        results.push({ ...base, status: "created", connection_id: conn.id, ...(reachable === undefined ? {} : { reachable }) });
      } catch (err) {
        results.push({ ...base, status: "failed", detail: (err as Error).message });
      }
    }

    const created = results.filter((r) => r.status === "created").length;
    res.json({
      created,
      failed: results.length - created,
      ...(poolId ? { pool_id: poolId, pool_name } : {}),
      results,
    });
  }),
);

// ── /detect — guess a printer's firmware from its URL ───────────────────────
// Best-effort, server-side (SSRF-guarded + no browser CORS). Probes the
// distinctive well-known endpoint of each manager in order — Moonraker first
// (most distinctive), then the shared /api/version (OctoPrint vs PrusaLink by
// its `text`/`server` strings), then Duet's machine model. Unknown → null (the
// UI keeps the user's default).
const DetectBody = z.object({
  url: z.string().min(1).max(500),
  api_key: optionalText(500),
});


async function probeJson(url: string, headers: Record<string, string>): Promise<unknown | undefined> {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    await assertSafeMachineUrl(url);
    const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    return await res.json().catch(() => null);
  } catch {
    return undefined;
  }
}

/** A controller's plain-text reply ($I, $$), capped; undefined when it did not answer 200 or the address
 *  is not one a machine may have. */
async function probeText(url: string, headers: Record<string, string>): Promise<string | undefined> {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    await assertSafeMachineUrl(url);
    const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    return (await res.text()).slice(0, 64 * 1024);
  } catch {
    return undefined;
  }
}

// AI-REACH: exempt — probes an address on the person's network with an API
// key they type; the assistant never handles a secret, and a chat must not
// point the server at arbitrary hosts on someone's LAN
bulkRouter.post(
  "/detect",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = DetectBody.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    const baseRaw = parsed.data.url.trim().replace(/\/+$/, "");
    const h: Record<string, string> = parsed.data.api_key ? { "X-Api-Key": parsed.data.api_key } : {};

    const hit = await detectPrinterFirmware(baseRaw, url => probeJson(url, h)) ?? await detectControllerFirmware(baseRaw, url => probeText(url, h));
    if (hit) return void res.json(hit);
    res.json({ type: null, detail: "no known firmware answered. Pick the type manually" });
  }),
);
