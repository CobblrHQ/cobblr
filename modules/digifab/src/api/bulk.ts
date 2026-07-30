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
import { ensureDeclarativeDrivers, createPool, addPoolMember } from "./farm-build.js";

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
  pool_name: z.string().min(1).max(120).optional(), // omit → don't pool
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
  api_key: z.string().max(500).optional(),
});

/** The endpoints we probe, in priority order. */
const DETECT_PROBES = [
  { path: "/printer/info", tag: "moonraker" as const },
  { path: "/api/version", tag: "version" as const },
  { path: "/machine/status", tag: "duet" as const },
];

/** Pure: given WHICH well-known endpoint answered 200 and its JSON body, what
 *  firmware is this? null = inconclusive (try the next probe). Exported so the
 *  mapping is unit-tested directly — the network/SSRF path can't reach a
 *  loopback test server (the guard blocks loopback/ULA by design). */
export function classifyFirmware(tag: "moonraker" | "version" | "duet", json: unknown): { type: string; detail: string } | null {
  if (tag === "moonraker") {
    return json && typeof json === "object" && "result" in json
      ? { type: "klipper-moonraker", detail: "Moonraker /printer/info responded" }
      : null;
  }
  if (tag === "version") {
    const blob = JSON.stringify(json ?? {}).toLowerCase();
    if (blob.includes("prusa")) return { type: "prusalink", detail: "/api/version looks like PrusaLink" };
    if (blob.includes("octoprint")) return { type: "octoprint", detail: "/api/version reports OctoPrint" };
    if (json && typeof json === "object" && ("api" in json || "server" in json)) {
      return { type: "octoprint", detail: "/api/version (OctoPrint-shaped)" };
    }
    return null;
  }
  // duet — any JSON object back from /machine/status (RRF3)
  return json && typeof json === "object" ? { type: "duet-rrf", detail: "Duet /machine/status responded" } : null;
}

async function probeJson(url: string, headers: Record<string, string>): Promise<unknown | undefined> {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    await assertSafeMachineUrl(url);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return undefined;
    return await res.json().catch(() => null);
  } catch {
    return undefined;
  }
}

bulkRouter.post(
  "/detect",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = DetectBody.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    const baseRaw = parsed.data.url.trim().replace(/\/+$/, "");
    const h: Record<string, string> = parsed.data.api_key ? { "X-Api-Key": parsed.data.api_key } : {};

    for (const { path, tag } of DETECT_PROBES) {
      const json = await probeJson(`${baseRaw}${path}`, h);
      if (json === undefined) continue; // unreachable / non-200 / blocked
      const hit = classifyFirmware(tag, json);
      if (hit) return void res.json(hit);
    }
    res.json({ type: null, detail: "no known firmware answered. Pick the type manually" });
  }),
);
