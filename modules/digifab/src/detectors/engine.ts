// Declarative detector engine — runs a DetectorManifest against a context and
// returns a probability in [0,1] (or null for no reading). The only code an
// external REST detector needs; new ones are added as a manifest + folder.
// SSRF-guarded on every outbound call, exactly like the machine drivers.

import { assertSafeMachineUrl } from "../drivers/ssrf.js";
import type { DetectorManifest } from "./manifest.js";
import { resolveReading, extractRaw, meetsMinVersion } from "./manifest.js";
import type { DetectorContext } from "./types.js";

/** A camera as reported by an external detector's listCameras (the import list). */
export interface DetectorCamera {
  id: string;
  name?: string;
  online?: boolean;
  /** The printer that owns this camera, if any (auto-registered camera). */
  printerId?: string;
}

/** A provider a printer can be registered under, + its config form (JSON Schema). */
export interface DetectorProvider {
  id: string;
  label?: string;
  schema?: unknown;
}

/** A printer the detector service owns, with its live print state. */
export interface DetectorPrinter {
  id: string;
  name?: string;
  status?: string;
  progress?: number | null;
}

/** The normalised view of a Cobblr connection a mirror mapping's exprs run over. */
export interface MirrorContext {
  base_url: string;
  apiKey: string;
  username: string;
  password: string;
  /** Per-printer creds for a perDevice mapping (e.g. Bambu's serial/host/access_code). */
  device?: Record<string, string>;
}

/** Fill a provider config from a mapping's `{ field: extract-expr }` over the
 *  connection context — the generic mirror (no per-type code here). */
export function buildMirrorConfig(config: Record<string, string>, ctx: MirrorContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(config)) {
    const v = extractRaw(expr, ctx)[0];
    out[field] = v ?? "";
  }
  return out;
}

const TIMEOUT_MS = 15_000;

function authHeaders(m: DetectorManifest, apiKey: string | null): Record<string, string> {
  const a = m.auth;
  if (!a || !apiKey) return {};
  return { [a.header]: `${a.prefix ?? ""}${apiKey}` };
}

function fillPath(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
}

async function fetchJson(method: string, url: string, init: RequestInit): Promise<unknown> {
  await assertSafeMachineUrl(url);
  const res = await fetch(url, { ...init, method, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** Run a declarative detector manifest. Throws on transport errors (the caller
 *  treats a throw as "no reading" and moves on). */
export async function runDetectorManifest(m: DetectorManifest, ctx: DetectorContext): Promise<{ probability: number } | null> {
  if (!ctx.connection) return null;
  const base = ctx.connection.baseUrl.replace(/\/+$/, "");
  const headers = authHeaders(m, ctx.connection.apiKey);

  if (m.shape === "frame-scorer" && m.detect) {
    const d = m.detect;
    let data: unknown;
    if (d.frameRef === "url") {
      // The detector fetches the frame itself — it must be able to reach this URL
      // (a LAN camera, or a snapshot endpoint). No configured URL → no reading.
      if (!ctx.cameraUrl) return null;
      const url = base + fillPath(d.path, { frameUrl: ctx.cameraUrl });
      data = await fetchJson(d.method, url, { headers });
    } else {
      // We POST the JPEG bytes — works for any frame source, including a relayed
      // snapshot the detector couldn't otherwise reach.
      const frame = await ctx.grabFrame();
      if (!frame) return null;
      const url = base + d.path;
      if (d.bodyType === "raw") {
        data = await fetchJson(d.method, url, {
          headers: { ...headers, "content-type": d.contentType ?? "image/jpeg" },
          body: new Uint8Array(frame),
        });
      } else {
        const form = new FormData();
        form.append(d.bodyField ?? "file", new Blob([new Uint8Array(frame)], { type: "image/jpeg" }), "frame.jpg");
        data = await fetchJson(d.method, url, { headers, body: form });
      }
    }
    const p = resolveReading(d, data);
    return p == null ? null : { probability: p };
  }

  if (m.shape === "camera-watcher" && m.status) {
    if (!ctx.cameraId) return null; // needs a device→camera mapping
    const url = base + fillPath(m.status.path, { deviceCam: ctx.cameraId });
    const data = await fetchJson(m.status.method, url, { headers });
    const p = resolveReading(m.status, data);
    return p == null ? null : { probability: p };
  }

  return null;
}

/** List the detector service's own cameras (camera-watcher import). Throws on a
 *  transport error so the caller can surface "unreachable". Returns [] when the
 *  manifest declares no listCameras. */
export async function listDetectorCameras(
  m: DetectorManifest,
  conn: { baseUrl: string; apiKey: string | null },
): Promise<DetectorCamera[]> {
  if (!m.listCameras) return [];
  const spec = m.listCameras;
  const base = conn.baseUrl.replace(/\/+$/, "");
  const data = await fetchJson(spec.method, base + spec.path, { headers: authHeaders(m, conn.apiKey) });
  const arr = spec.arrayPath ? extractRaw(spec.arrayPath, data)[0] : data;
  const rows = Array.isArray(arr) ? arr : [];
  const out: DetectorCamera[] = [];
  for (const row of rows) {
    const id = extractRaw(spec.map.id, row)[0];
    if (id == null || id === "") continue;
    const cam: DetectorCamera = { id: String(id) };
    if (spec.map.name) {
      const n = extractRaw(spec.map.name, row)[0];
      if (n != null) cam.name = String(n);
    }
    if (spec.map.online) cam.online = Boolean(extractRaw(spec.map.online, row)[0]);
    if (spec.map.printerId) {
      const p = extractRaw(spec.map.printerId, row)[0];
      if (p != null && p !== "") cam.printerId = String(p);
    }
    out.push(cam);
  }
  return out;
}

type Conn = { baseUrl: string; apiKey: string | null };

/** List the provider types + config schemas a printer can be registered under. */
export async function listDetectorProviders(m: DetectorManifest, conn: Conn): Promise<DetectorProvider[]> {
  if (!m.listProviders) return [];
  const spec = m.listProviders;
  const base = conn.baseUrl.replace(/\/+$/, "");
  const data = await fetchJson(spec.method, base + spec.path, { headers: authHeaders(m, conn.apiKey) });
  const arr = spec.arrayPath ? extractRaw(spec.arrayPath, data)[0] : data;
  const rows = Array.isArray(arr) ? arr : [];
  const out: DetectorProvider[] = [];
  for (const row of rows) {
    const id = extractRaw(spec.map.id, row)[0];
    if (id == null || id === "") continue;
    const p: DetectorProvider = { id: String(id) };
    if (spec.map.label) {
      const l = extractRaw(spec.map.label, row)[0];
      if (l != null) p.label = String(l);
    }
    if (spec.map.schema) p.schema = extractRaw(spec.map.schema, row)[0];
    out.push(p);
  }
  return out;
}

/** Register a printer with the service (caller supplies the body). Returns raw. */
export async function createDetectorPrinter(m: DetectorManifest, conn: Conn, body: unknown): Promise<unknown> {
  if (!m.createPrinter) throw new Error("this detector can't register printers");
  const base = conn.baseUrl.replace(/\/+$/, "");
  return fetchJson(m.createPrinter.method, base + m.createPrinter.path, {
    headers: { ...authHeaders(m, conn.apiKey), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Bind a monitor (camera + printer) so the service actually watches. */
export async function createDetectorMonitor(m: DetectorManifest, conn: Conn, body: unknown): Promise<unknown> {
  if (!m.createMonitor) throw new Error("this detector can't create monitors");
  const base = conn.baseUrl.replace(/\/+$/, "");
  return fetchJson(m.createMonitor.method, base + m.createMonitor.path, {
    headers: { ...authHeaders(m, conn.apiKey), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** List the service's printers with their live print state. */
export async function listDetectorPrinters(m: DetectorManifest, conn: Conn): Promise<DetectorPrinter[]> {
  if (!m.listPrinters) return [];
  const spec = m.listPrinters;
  const base = conn.baseUrl.replace(/\/+$/, "");
  const data = await fetchJson(spec.method, base + spec.path, { headers: authHeaders(m, conn.apiKey) });
  const arr = spec.arrayPath ? extractRaw(spec.arrayPath, data)[0] : data;
  const rows = Array.isArray(arr) ? arr : [];
  const out: DetectorPrinter[] = [];
  for (const row of rows) {
    const id = extractRaw(spec.map.id, row)[0];
    if (id == null || id === "") continue;
    const p: DetectorPrinter = { id: String(id) };
    if (spec.map.name) {
      const n = extractRaw(spec.map.name, row)[0];
      if (n != null) p.name = String(n);
    }
    if (spec.map.status) {
      const s = extractRaw(spec.map.status, row)[0];
      if (s != null) p.status = String(s);
    }
    if (spec.map.progress) {
      const v = Number(extractRaw(spec.map.progress, row)[0]);
      p.progress = Number.isFinite(v) ? v : null;
    }
    out.push(p);
  }
  return out;
}

/** Read the running service's version (a semver string), or null if the manifest
 *  declares no `serviceVersion` or the read fails. */
export async function getDetectorVersion(m: DetectorManifest, conn: Conn): Promise<string | null> {
  if (!m.serviceVersion) return null;
  const base = conn.baseUrl.replace(/\/+$/, "");
  const data = await fetchJson(m.serviceVersion.method, base + m.serviceVersion.path, { headers: authHeaders(m, conn.apiKey) });
  const v = extractRaw(m.serviceVersion.extract, data)[0];
  return v == null ? null : String(v);
}

/** The test-button probe: reachability (health endpoint or a bare GET) PLUS a
 *  version-floor check when the manifest declares `minServiceVersion` — so a
 *  reachable-but-too-old service reports `ok: false` with a clear reason. */
export async function testDetectorManifest(
  m: DetectorManifest,
  baseUrl: string,
  apiKey: string | null,
): Promise<{ ok: boolean; detail?: string; version?: string | null; compatible?: boolean }> {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = authHeaders(m, apiKey);
  const path = m.health ? base + m.health.path : base + "/";
  const method = m.health?.method ?? "GET";
  let ok: boolean;
  let detail: string | undefined;
  try {
    await assertSafeMachineUrl(path);
    const res = await fetch(path, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    ok = res.ok;
    detail = res.ok ? undefined : `status ${res.status}`;
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  // Version floor (when declared).
  let version: string | null | undefined;
  let compatible: boolean | undefined;
  if (m.serviceVersion) {
    try {
      version = await getDetectorVersion(m, { baseUrl, apiKey });
    } catch {
      version = null;
    }
    if (m.minServiceVersion) {
      compatible = meetsMinVersion(version, m.minServiceVersion);
      if (!compatible) detail = `needs ${m.name} ≥ ${m.minServiceVersion}${version ? ` (found ${version})` : " (version unknown)"}`;
    }
  }
  return { ok: ok && compatible !== false, detail, version, compatible };
}
