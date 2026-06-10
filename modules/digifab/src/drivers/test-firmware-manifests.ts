// Verify the firmware driver manifests against the DeclarativeDriver engine.
//   npx tsx modules/digifab/src/drivers/test-firmware-manifests.ts
//
// Two halves per manifest:
//   1. It parses against the DriverManifest Zod schema (what install checks).
//   2. It drives a FAKE firmware HTTP API through the real DeclarativeDriver:
//      test → listDevices → upload → submit → getJobStatus. fetch is stubbed
//      with in-memory handlers (no sockets, no SSRF concern — the SSRF guard
//      still runs on the URL, so we use LAN-shaped 192.168.x base URLs).
//
// This exercises the engine extension (raw-body upload + {filename} +
// templated submit body) end to end, manager by manager.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DriverManifest } from "./manifest.js";
import { DeclarativeDriver } from "./declarative.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = resolve(HERE, "../../drivers-catalog");

const checks: { l: string; ok: boolean }[] = [];
const note = (l: string, ok: boolean, d = "") => { checks.push({ l, ok }); console.log(`${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); };

type Handler = (req: { method: string; path: string; body: unknown; headers: Record<string, string> }) => { status?: number; json?: unknown; text?: string };

// Install an in-memory fetch that routes to `routes` keyed by "METHOD /path"
// (path without query). Records calls for assertions.
function installFakeFetch(routes: Record<string, Handler>): { calls: { method: string; url: string; rawBody: boolean; auth?: string; authz?: string }[]; restore: () => void } {
  const calls: { method: string; url: string; rawBody: boolean; auth?: string; authz?: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const isRaw = init?.body instanceof Uint8Array;
    calls.push({ method, url, rawBody: isRaw, auth: headers["X-Api-Key"], authz: headers["Authorization"] });
    const key = `${method} ${u.pathname}`;
    const h = routes[key];
    if (!h) return new Response(`no route ${key}`, { status: 404 });
    let body: unknown = undefined;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    const r = h({ method, path: u.pathname, body, headers });
    const status = r.status ?? 200;
    if (status === 204) return new Response(null, { status });
    if (r.text !== undefined) return new Response(r.text, { status, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(r.json ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

function load(name: string): DriverManifest {
  const raw = JSON.parse(readFileSync(resolve(CATALOG, name), "utf8"));
  const parsed = DriverManifest.safeParse(raw);
  note(`${name} parses against the manifest schema`, parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues?.[0]));
  if (!parsed.success) throw new Error(`${name} invalid`);
  return parsed.data;
}

const CFG = { baseUrl: "http://192.168.50.10", apiKey: "test-key" };
const FILE = new Uint8Array([1, 2, 3, 4]);

// ── OctoPrint ────────────────────────────────────────────────────────────
{
  const m = load("octoprint.json");
  const f = installFakeFetch({
    "GET /api/version": () => ({ json: { server: "1.9.0" } }),
    "GET /api/printer": () => ({ json: { state: { text: "Operational" } } }),
    "POST /api/files/local": () => ({ json: { files: { local: { name: "thing.gcode" } } } }),
    "POST /api/files/local/thing.gcode": () => ({ status: 204 }),
    "GET /api/job": () => ({ json: { state: "Printing", progress: { completion: 42 } } }),
  });
  try {
    const d = new DeclarativeDriver(m, CFG);
    note("octoprint testConnection ok", (await d.testConnection()).ok);
    const devs = await d.listDevices();
    note("octoprint listDevices → 1 named device", devs.length === 1 && devs[0]!.name === "OctoPrint");
    const up = await d.uploadFile(FILE, "thing.gcode");
    note("octoprint upload (multipart) → fileId from response", up.fileId === "thing.gcode" && !f.calls.find((c) => c.url.includes("/files/local") && c.method === "POST")!.rawBody);
    const sub = await d.submitJob({ fileId: up.fileId });
    note("octoprint submit → queued jobId", sub.queued && sub.jobId === "thing.gcode");
    const st = await d.getJobStatus(sub.jobId!);
    note("octoprint status maps Printing→printing + progress 0..1", st.state === "printing" && st.progress === 0.42);
    note("octoprint sent X-Api-Key auth", f.calls.every((c) => c.auth === "test-key"));
  } finally { f.restore(); }
}

// ── Klipper / Moonraker ───────────────────────────────────────────────────
{
  const m = load("klipper-moonraker.json");
  const f = installFakeFetch({
    "GET /printer/info": () => ({ json: { result: { hostname: "voron", state: "ready" } } }),
    "POST /server/files/upload": () => ({ json: { item: { path: "thing.gcode" } } }),
    "POST /printer/print/start": () => ({ json: { result: "ok" } }),
    "GET /printer/objects/query": () => ({ json: { result: { status: { print_stats: { state: "printing" }, virtual_sdcard: { progress: 0.5 } } } } }),
  });
  try {
    const d = new DeclarativeDriver(m, CFG);
    note("klipper testConnection ok", (await d.testConnection()).ok);
    const devs = await d.listDevices();
    note("klipper listDevices → hostname", devs[0]!.name === "voron");
    const up = await d.uploadFile(FILE, "thing.gcode");
    note("klipper upload → item.path", up.fileId === "thing.gcode");
    const sub = await d.submitJob({ fileId: up.fileId });
    note("klipper submit (filename in query) → queued", sub.queued && f.calls.some((c) => c.url.includes("filename=thing.gcode")));
    const st = await d.getJobStatus(sub.jobId!);
    note("klipper status printing + progress 0.5", st.state === "printing" && st.progress === 0.5);
  } finally { f.restore(); }
}

// ── Duet RRF (raw upload + templated path) ────────────────────────────────
{
  const m = load("duet-rrf.json");
  const f = installFakeFetch({
    "GET /rr_status": () => ({ json: { status: "I", fractionPrinted: 0 } }),
    "PUT /rr_upload": () => ({ json: { err: 0 } }),
    "GET /rr_gcode": () => ({ json: { buff: 1 } }),
  });
  try {
    const d = new DeclarativeDriver(m, CFG);
    note("duet testConnection ok", (await d.testConnection()).ok);
    const up = await d.uploadFile(FILE, "bracket.gcode");
    const putCall = f.calls.find((c) => c.method === "PUT")!;
    note("duet upload is RAW body (not multipart)", putCall.rawBody === true);
    note("duet upload templates {filename} into the path", putCall.url.includes("name=0%3A%2Fgcodes%2Fbracket.gcode") || putCall.url.includes("bracket.gcode"));
    note("duet fileId = filename", up.fileId === "bracket.gcode");
    const sub = await d.submitJob({ fileId: up.fileId });
    note("duet submit (M32 with fileId in path) → queued", sub.queued && f.calls.some((c) => c.url.includes("rr_gcode") && c.url.includes("bracket.gcode")));
    // now report printing
    f.restore();
  } finally { f.restore(); }
  // status mapping check with a fresh stub returning printing
  const f2 = installFakeFetch({ "GET /rr_status": () => ({ json: { status: "P", fractionPrinted: 73 } }) });
  try {
    const d = new DeclarativeDriver(m, CFG);
    const st = await d.getJobStatus("bracket.gcode");
    note("duet status P→printing + progress 73→0.73", st.state === "printing" && st.progress === 0.73);
  } finally { f2.restore(); }
}

// ── PrusaLink (raw PUT upload) ────────────────────────────────────────────
{
  const m = load("prusalink.json");
  const f = installFakeFetch({
    "GET /api/version": () => ({ json: { api: "2.0.0" } }),
    "GET /api/v1/status": () => ({ json: { printer: { state: "PRINTING" }, job: { progress: 88 } } }),
    "PUT /api/v1/files/usb/thing.gcode": () => ({ json: { name: "thing.gcode" } }),
    "POST /api/v1/files/usb/thing.gcode": () => ({ json: {} }),
  });
  try {
    const d = new DeclarativeDriver(m, CFG);
    note("prusalink testConnection ok", (await d.testConnection()).ok);
    const up = await d.uploadFile(FILE, "thing.gcode");
    const putCall = f.calls.find((c) => c.method === "PUT")!;
    note("prusalink upload is RAW body PUT to {filename} path", putCall.rawBody === true && putCall.url.endsWith("/api/v1/files/usb/thing.gcode"));
    const sub = await d.submitJob({ fileId: up.fileId });
    note("prusalink submit → queued", sub.queued);
    const st = await d.getJobStatus("thing.gcode");
    note("prusalink status PRINTING→printing + progress 0.88", st.state === "printing" && st.progress === 0.88);
  } finally { f.restore(); }
}

// ── FluidNC (GRBL laser/CNC — plain-text status, the text-parse path) ───────
{
  const m = load("fluidnc.json");
  // The /command endpoint is one path; the GRBL report is plain text. Vary the
  // status reply per phase by swapping the stub.
  const f = installFakeFetch({
    "GET /command": () => ({ text: "<Idle|MPos:0.000,0.000,0.000|FS:0,0>" }),
    "POST /upload": () => ({ json: { files: [{ name: "cut.gcode" }], status: "ok" } }),
  });
  try {
    const d = new DeclarativeDriver(m, CFG);
    note("fluidnc testConnection ok (text status)", (await d.testConnection()).ok);
    const up = await d.uploadFile(FILE, "cut.gcode");
    note("fluidnc upload (multipart 'myfile') → fileId=filename", up.fileId === "cut.gcode" && !f.calls.find((c) => c.url.includes("/upload"))!.rawBody);
    const sub = await d.submitJob({ fileId: up.fileId });
    note("fluidnc submit ($SD/Run with file in path) → queued", sub.queued && f.calls.some((c) => c.url.includes("command") && c.url.includes("cut.gcode")));
    const stIdle = await d.getJobStatus(up.fileId);
    note("fluidnc text status Idle→completed", stIdle.state === "completed");
  } finally { f.restore(); }
  // Running with SD progress in the GRBL report
  const f2 = installFakeFetch({ "GET /command": () => ({ text: "<Run|MPos:1,2,3|SD:42.5,/cut.gcode>" }) });
  try {
    const d = new DeclarativeDriver(m, CFG);
    const st = await d.getJobStatus("cut.gcode");
    note("fluidnc text status Run→printing + SD progress 42.5→0.425", st.state === "printing" && st.progress === 0.425);
  } finally { f2.restore(); }
}

// ── Home Assistant (ACTUATOR — command-and-forget; the Bearer-prefix + body-fill path) ──
{
  const m = load("home-assistant.json");
  let serviceBody: Record<string, unknown> | null = null;
  const f = installFakeFetch({
    "GET /api/": () => ({ json: { message: "API running." } }),
    "POST /api/services/script/turn_on": (req) => { serviceBody = req.body as Record<string, unknown>; return { json: [] }; },
  });
  try {
    const d = new DeclarativeDriver(m, { baseUrl: "http://192.168.50.20", apiKey: "ha-token" });
    note("home-assistant testConnection ok", (await d.testConnection()).ok);
    const res = await d.runCommand("run-zone", { zone: "3", seconds: "45" });
    note("home-assistant run-zone acks ok", res.ok);
    const call = f.calls.find((c) => c.url.endsWith("/api/services/script/turn_on"))!;
    note("home-assistant sends Authorization: Bearer <token> (the auth prefix)", call?.authz === "Bearer ha-token");
    const vars = (serviceBody as { variables?: Record<string, unknown>; entity_id?: string } | null);
    note(
      "home-assistant fills {zone}/{seconds} into the HA service body",
      !!vars && vars.entity_id === "script.water_zone" && vars.variables?.zone === "3" && vars.variables?.seconds === "45",
    );
    const unknown = await d.runCommand("nope", {});
    note("home-assistant unknown command → ok:false, no throw", unknown.ok === false);
  } finally { f.restore(); }
}

const fail = checks.filter((c) => !c.ok);
console.log(`\n==== FIRMWARE MANIFESTS — ${checks.length - fail.length}/${checks.length} ====`);
if (fail.length) { console.log("FAILED:", fail.map((c) => c.l).join(" | ")); process.exit(1); }
