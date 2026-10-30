// @ts-nocheck -- vendored conformance kit, written for a looser tsconfig; see README.md
// A fake Cobblr service for Cobblr's own tests (services.md §3–§5, S4).
//
// Zero dependencies beyond node: and ./hmac.js. Implements the whole
// external contract so a caller can be tested against every path:
//   - the manifest (unsigned) with manifest_version = sha256(bytes),
//   - cobblr-hmac-v1 on everything else (nonce replay, 300 s window),
//   - content-addressed blobs streamed to disk (100 MB+ with flat memory),
//     HEAD, whole PUT with hash_mismatch, GET with Range,
//   - jobs through every state, needs_input and /input, cancel,
//     idempotency (same job / 409 on a changed body), busy past the queue,
//     input_timeout after 7 days, retention sweep after 24 h,
//   - options endpoints in the slice.* and design.* shapes.
//
// Jobs advance **one step per poll** by default (deterministic tests); pass
// `advance: "timer"` for wall-clock behaviour. `now` makes time injectable.
//
// Capabilities:
//   fake.run     scenario driver: input.scenario =
//                  "done" | "fail" | "retryable" | "needs_input" | "needs_input_preview" | "hang" | "output_bytes"
//   slice.model  canned slice (grams_per_tool per filament), slice options
//   design.part  canned design (report + stl/preview), design options
//   fake.lookup  SYNC (like parts.search): the submit answer is the finished
//                job — output {items, total} + previews/p1, previews/p2;
//                q "nothing" → items []; fail: true → failed busy (retryable)
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_BODY_SHA256, HEADER, NonceCache, WINDOW_S, mintKey, parseKeyString, verifyRequest, type ServiceKey } from "./hmac.js";

export type JobStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled";
const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);
export const NEEDS_INPUT_TTL_MS = 7 * 24 * 3600 * 1000;
export const RETENTION_MS = 24 * 3600 * 1000;

export interface FileRef { sha256: string; size?: number; type?: string; name?: string }
export interface JobError { code: string; message: string; retryable: boolean }

export interface FakeJob {
  job_id: string;
  capability: string;
  status: JobStatus;
  progress: number | null;
  message: string | null;
  needs: { prompt: string; input_schema: object; files?: Record<string, FileRef> } | null;
  output: object | null;
  files: Record<string, FileRef> | null;
  error: JobError | null;
  // internals
  input: Record<string, unknown>;
  inFiles: Record<string, FileRef>;
  idempotencyKey: string;
  bodyHash: string;
  steps: Array<(j: FakeJob) => void | Promise<void>>;
  createdAt: number;
  finishedAt: number | null;
  needsSince: number | null;
  answer: Record<string, unknown> | null;
  callback: { url: string; token?: string } | null;
}

export interface FakeServiceOptions {
  host?: string;
  port?: number;
  /** Key strings `<key_id>.<secret>` accepted. Default: one fresh key. */
  keys?: string[];
  dataDir?: string;
  basePath?: string;
  maxFileMb?: number;
  maxConcurrentJobs?: number;
  /** Queue up to maxConcurrentJobs × queueFactor non-terminal jobs, then `busy`. */
  queueFactor?: number;
  advance?: "poll" | "timer";
  timerMs?: number;
  /** Clock in ms (signature window, input_timeout, retention). */
  now?: () => number;
  version?: string;
  /** Log verify failures etc. */
  log?: (msg: string) => void;
}

export interface FakeService {
  /** Origin, e.g. http://127.0.0.1:41234 */
  url: string;
  /** url + base path, e.g. http://127.0.0.1:41234/v1 */
  baseUrl: string;
  key: ServiceKey;
  keyString: string;
  manifest: Record<string, unknown>;
  manifestVersion: string;
  jobs: Map<string, FakeJob>;
  mintKey(): string;
  revokeKey(keyId: string): boolean;
  /** Drop finished jobs and unreferenced blobs older than 24 h. */
  sweep(): void;
  /** Number of requests that reached the handler (for idempotency tests). */
  stats: { submits: number; jobsCreated: number; requests: number; rejectedSignatures: number };
  close(): Promise<void>;
}

export const MULTIPLE_CAP = 16;
const LABEL_RE = /^[a-z0-9_-]{1,40}$/;

/** services.md §3: a plain slot is its name; a `multiple` slot takes `<name>/<label>` keys, up to 16. Undeclared keys are refused. */
function checkFiles(decls: Array<{ name: string; required?: boolean; multiple?: boolean; max?: number }>, files: Record<string, unknown>) {
  const plain = new Map(decls.filter((d) => !d.multiple).map((d) => [d.name, d]));
  const multi = new Map(decls.filter((d) => d.multiple).map((d) => [d.name, d]));
  const counts = new Map([...multi.keys()].map((k) => [k, 0]));
  for (const key of Object.keys(files)) {
    if (plain.has(key)) continue;
    const i = key.indexOf("/");
    const slot = i > 0 ? key.slice(0, i) : key;
    const label = i > 0 ? key.slice(i + 1) : "";
    if (i > 0 && multi.has(slot) && LABEL_RE.test(label)) { counts.set(slot, counts.get(slot)! + 1); continue; }
    if (multi.has(slot)) throw new HttpError(400, "unsupported_input", `file ${key}: labels in slot ${slot} must match [a-z0-9_-]{1,40}`);
    throw new HttpError(400, "unsupported_input", `file ${key} is not declared in files_in`);
  }
  for (const [n, c] of counts) {
    const cap = Math.min(multi.get(n)!.max ?? MULTIPLE_CAP, MULTIPLE_CAP);
    if (c > cap) throw new HttpError(400, "unsupported_input", `slot ${n} takes at most ${cap} files, got ${c}`);
    if (multi.get(n)!.required && c === 0) throw new HttpError(400, "unsupported_input", `slot ${n} needs at least one file`);
  }
  for (const [n, d] of plain) if (d.required && !(n in files)) throw new HttpError(400, "unsupported_input", `file ${n} is required`);
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) { super(message); }
}

const PNG_1PX = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");

function slicePrinterModels() {
  return [
    { id: "prusa/mini-plus-is", display_name: "Prusa MINI+ (Input Shaper)", native_name: "Original Prusa MINI & MINI+ Input Shaper",
      build_volume_mm: [180, 180, 180], nozzles: [0.4, 0.6], qualities: [{ id: "0.20mm", layer_height_mm: 0.2, label: "0.20 mm SPEED" }, { id: "0.15mm", layer_height_mm: 0.15, label: "0.15 mm QUALITY" }],
      filament_presets: [{ name: "Prusament PLA @MINIIS", material: "PLA" }, { name: "Generic PETG @MINIIS", material: "PETG" }],
      supports_auto_orient: false, output: "gcode", tools: 1 },
    { id: "bambulab/a1", display_name: "Bambu Lab A1", native_name: "Bambu Lab A1 0.4 nozzle",
      build_volume_mm: [256, 256, 256], nozzles: [0.4], qualities: [{ id: "0.20mm", layer_height_mm: 0.2, label: "0.20 mm Standard" }],
      filament_presets: [{ name: "Generic PLA @BBL A1", material: "PLA" }, { name: "Generic PETG @BBL A1", material: "PETG" }],
      supports_auto_orient: true, output: "3mf", tools: 4 },
  ];
}

function buildManifest(version: string, basePath: string, maxFileMb: number, maxConcurrentJobs: number) {
  const fileTypes = ["application/octet-stream", "model/stl", "model/step", "model/3mf"];
  return {
    cobblr_service: 1,
    id: "org.cobblr.fake",
    name: "Fake service (conformance kit)",
    version,
    publisher: "cobblr conformance kit",
    docs_url: "https://example.org/cobblr-conformance-kit",
    auth: { schemes: ["cobblr-hmac-v1"] },
    api: { base_path: basePath },
    limits: { max_file_mb: maxFileMb, max_concurrent_jobs: maxConcurrentJobs },
    capabilities: [
      {
        id: "fake.run", version: 1, title: "Run a scripted fake job",
        summary: "Test double. Walks a job through a scripted path: done, fail, retryable failure, needs_input (optionally with preview files), hang until cancelled, or a generated output file.",
        effect: "none", mode: "async", typical_seconds: 1,
        input_schema: {
          type: "object", required: ["scenario"], additionalProperties: false,
          properties: {
            scenario: { enum: ["done", "fail", "retryable", "needs_input", "needs_input_preview", "hang", "output_bytes"] },
            output_bytes: { type: "integer", minimum: 0 },
            steps: { type: "integer", minimum: 1, maximum: 50 },
            echo: {},
          },
        },
        output_schema: { type: "object" },
        files_in: [{ name: "model", types: fileTypes, required: false },
          { name: "refs", types: fileTypes, multiple: true }],
        files_out: [{ name: "result", types: ["application/octet-stream"], optional: true }, { name: "echo", types: fileTypes, optional: true },
          { name: "refs", types: fileTypes, multiple: true, optional: true },
          { name: "preview", types: ["image/png"], optional: true }, { name: "stl", types: ["model/stl"], optional: true }],
      },
      {
        id: "fake.lookup", version: 1, title: "Look something up (fake, sync)",
        summary: "Test double of a sync capability like parts.search: the submit answer is the finished job, with output and preview files.",
        effect: "none", mode: "sync", typical_seconds: 0.1,
        input_schema: { type: "object", required: ["q"], additionalProperties: false,
          properties: { q: { type: "string" }, fail: { type: "boolean" } } },
        output_schema: { type: "object", required: ["items", "total"],
          properties: { items: { type: "array" }, total: { type: "integer" } } },
        files_out: [{ name: "previews", types: ["image/png"], multiple: true, optional: true }],
      },
      {
        id: "slice.model", version: 1, title: "Slice a model (fake)",
        summary: "Test double of the reference slicer. Answers a canned slice with time and grams per tool for any printer model in its options, and unsupported_printer otherwise.",
        effect: "none", mode: "async", typical_seconds: 1,
        input_schema: {
          type: "object", required: ["printer_model", "nozzle_mm", "quality", "filament"],
          properties: {
            printer_model: { type: "string" }, nozzle_mm: { type: "number" }, quality: { type: "string" },
            filament: { type: "array", minItems: 1, items: { type: "object", required: ["material"] } },
            object_tool: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
            supports: { enum: [true, false, "auto"] }, brim: { type: "boolean" }, orientation: { enum: ["as_is", "auto"] },
          },
        },
        output_schema: {
          type: "object", required: ["estimated_seconds", "grams_per_tool", "total_grams", "layers", "slicer", "settings_snapshot", "profile_sha"],
          properties: {
            estimated_seconds: { type: "number" }, grams_per_tool: { type: "array", items: { type: "number" } }, total_grams: { type: "number" },
            layers: { type: "integer" }, slicer: { type: "object" }, settings_snapshot: { type: "object" }, profile_sha: { type: "string" },
          },
        },
        files_in: [{ name: "model", types: ["model/stl", "model/step", "model/3mf"], required: true }],
        files_out: [{ name: "gcode", types: ["text/x.gcode", "model/3mf"] }, { name: "plain_gcode", types: ["text/x.gcode"], optional: true }, { name: "preview", types: ["image/png"] }],
        options_endpoint: `${basePath}/capabilities/slice.model/options`,
      },
      {
        id: "design.part", version: 1, title: "Design a part (fake)",
        summary: "Test double of the reference design service. Accepts source or a template and answers a canned report with an STL and a preview.",
        effect: "none", mode: "async", typical_seconds: 1,
        input_schema: {
          type: "object", properties: {
            source: { type: "string" }, source_lang: { enum: ["solidcraft", "openscad"] }, template: { type: "string" }, params: { type: "object" },
            prompt: { type: "string" }, material: { type: "string" }, units: { const: "mm" },
            max_bbox_mm: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 }, tolerances: { type: "object" },
          },
          anyOf: [{ required: ["source"] }, { required: ["template"] }],
        },
        output_schema: { type: "object", required: ["source_lang", "params", "report"] },
        files_out: [{ name: "source", types: ["application/json", "text/x-openscad"] }, { name: "stl", types: ["model/stl"] }, { name: "preview", types: ["image/png"] }, { name: "step", types: ["model/step"], optional: true }],
        options_endpoint: `${basePath}/capabilities/design.part/options`,
      },
    ],
  };
}

export async function startFakeService(opts: FakeServiceOptions = {}): Promise<FakeService> {
  const now = opts.now ?? (() => Date.now());
  const nowS = () => Math.floor(now() / 1000);
  const basePath = opts.basePath ?? "/v1";
  const maxFileMb = opts.maxFileMb ?? 200;
  const maxConcurrent = opts.maxConcurrentJobs ?? 2;
  const queueLimit = maxConcurrent * (opts.queueFactor ?? 4);
  const version = opts.version ?? "0.1.0";
  const log = opts.log ?? (() => {});
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "cobblr-fake-"));
  const ownsDataDir = !opts.dataDir;
  const blobDir = join(dataDir, "blobs");
  mkdirSync(blobDir, { recursive: true });

  const keys = new Map<string, string>();
  const initial = (opts.keys && opts.keys.length ? opts.keys : [mintKey().keyString]).map(parseKeyString);
  for (const k of initial) keys.set(k.keyId, k.secret);

  const manifest = buildManifest(version, basePath, maxFileMb, maxConcurrent);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestVersion = createHash("sha256").update(manifestBytes).digest("hex");
  const nonces = new NonceCache(WINDOW_S);
  const jobs = new Map<string, FakeJob>();
  const byKey = new Map<string, { jobId: string; at: number }>();
  const blobAt = new Map<string, number>();
  const stats = { submits: 0, jobsCreated: 0, requests: 0, rejectedSignatures: 0 };

  const blobPath = (sha: string) => join(blobDir, sha);
  const hasBlob = (sha: string) => existsSync(blobPath(sha));

  function sendJson(res: ServerResponse, status: number, body: unknown) {
    const b = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "content-length": String(b.length) });
    res.end(b);
  }
  function sendError(res: ServerResponse, e: HttpError) {
    sendJson(res, e.status, { error: { code: e.code, message: e.message, retryable: e.retryable } });
  }

  function precheck(req: IncomingMessage) {
    const hd = req.headers;
    const keyId = hd[HEADER.keyId] as string | undefined;
    const ts = hd[HEADER.timestamp] as string | undefined;
    if (!keyId || !ts || !hd[HEADER.nonce] || !hd[HEADER.signature]) throw new HttpError(401, "bad_signature", "missing signature headers");
    if (!keys.has(keyId)) throw new HttpError(401, "bad_signature", "unknown key");
    if (!/^\d+$/.test(ts) || Math.abs(nowS() - Number(ts)) > WINDOW_S) throw new HttpError(401, "bad_signature", "timestamp outside window");
  }

  function verify(req: IncomingMessage, bodySha: string) {
    const r = verifyRequest({
      headers: req.headers as Record<string, string>, method: req.method ?? "GET", pathAndQuery: req.url ?? "/",
      bodySha256: bodySha, lookupSecret: (id) => keys.get(id), nonces, nowS: nowS(),
    });
    if (!r.ok) {
      stats.rejectedSignatures++;
      log(`signature rejected: ${r.reason}`);
      throw new HttpError(401, "bad_signature", "request signature did not verify");
    }
  }

  async function readJson(req: IncomingMessage): Promise<{ body: any; sha: string }> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > 1024 * 1024) throw new HttpError(413, "too_large", "JSON body over 1 MB");
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks);
    const sha = createHash("sha256").update(raw).digest("hex");
    verify(req, sha);
    if (raw.length === 0) return { body: {}, sha };
    try { return { body: JSON.parse(raw.toString("utf8")), sha }; }
    catch { throw new HttpError(400, "unsupported_input", "body is not JSON"); }
  }

  async function drainAndVerify(req: IncomingMessage) {
    const h = createHash("sha256");
    for await (const c of req) h.update(c as Buffer);
    verify(req, h.digest("hex"));
  }

  // ---- blobs ---------------------------------------------------------------
  async function putBlob(req: IncomingMessage, res: ServerResponse, sha: string) {
    precheck(req);
    const limit = maxFileMb * 1024 * 1024;
    const declared = Number(req.headers["content-length"] ?? "NaN");
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      throw new HttpError(413, "too_large", `file over ${maxFileMb} MB`);
    }
    const tmp = join(blobDir, `.tmp-${randomBytes(8).toString("hex")}`);
    const out = createWriteStream(tmp);
    const h = createHash("sha256");
    let size = 0;
    let tooBig = false;
    try {
      for await (const c of req) {
        const b = c as Buffer;
        size += b.length;
        if (size > limit) { tooBig = true; break; }
        h.update(b);
        if (!out.write(b)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    if (tooBig) { unlinkSync(tmp); req.resume(); throw new HttpError(413, "too_large", `file over ${maxFileMb} MB`); }
    const got = h.digest("hex");
    try { verify(req, got); } catch (e) { unlinkSync(tmp); throw e; }
    if (got !== sha) { unlinkSync(tmp); throw new HttpError(400, "hash_mismatch", `body hashes to ${got}, not ${sha}`); }
    const existed = hasBlob(sha);
    if (existed) unlinkSync(tmp); else renameSync(tmp, blobPath(sha));
    blobAt.set(sha, now());
    sendJson(res, existed ? 200 : 201, { sha256: sha, size });
  }

  function getBlob(req: IncomingMessage, res: ServerResponse, sha: string, head: boolean) {
    verify(req, EMPTY_BODY_SHA256);
    if (!hasBlob(sha)) {
      if (head) { res.writeHead(404); res.end(); return; }
      throw new HttpError(404, "x-not_found", "no such blob");
    }
    const size = statSync(blobPath(sha)).size;
    const base = { "accept-ranges": "bytes", etag: `"${sha}"`, "content-type": "application/octet-stream" };
    if (head) { res.writeHead(200, { ...base, "content-length": String(size) }); res.end(); return; }
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start: number, end: number;
      if (!m || (m[1] === "" && m[2] === "")) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
      if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
      if (start >= size || start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` });
      createReadStream(blobPath(sha), { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...base, "content-length": String(size) });
    createReadStream(blobPath(sha)).pipe(res);
  }

  async function writeGenerated(bytes: number): Promise<FileRef> {
    // Deterministic content, streamed so a 100 MB output never sits in memory.
    const tmp = join(blobDir, `.tmp-${randomBytes(8).toString("hex")}`);
    const out = createWriteStream(tmp);
    const h = createHash("sha256");
    const block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff;
    let left = bytes;
    while (left > 0) {
      const b = left >= block.length ? block : block.subarray(0, left);
      h.update(b);
      if (!out.write(b)) await new Promise<void>((r) => out.once("drain", () => r()));
      left -= b.length;
    }
    await new Promise<void>((r) => out.end(r));
    const sha = h.digest("hex");
    if (hasBlob(sha)) unlinkSync(tmp); else renameSync(tmp, blobPath(sha));
    blobAt.set(sha, now());
    return { sha256: sha, size: bytes, type: "application/octet-stream", name: `result-${bytes}.bin` };
  }

  function storeBytes(buf: Buffer, type: string, name: string): FileRef {
    const sha = createHash("sha256").update(buf).digest("hex");
    if (!hasBlob(sha)) {
      const tmp = join(blobDir, `.tmp-${randomBytes(8).toString("hex")}`);
      writeFileSync(tmp, buf);
      renameSync(tmp, blobPath(sha));
    }
    blobAt.set(sha, now());
    return { sha256: sha, size: buf.length, type, name };
  }

  // ---- jobs ----------------------------------------------------------------
  const set = (j: FakeJob, s: JobStatus, progress: number | null = null, message: string | null = null) => {
    j.status = s; j.progress = progress; j.message = message;
    if (TERMINAL.has(s)) j.finishedAt = now();
  };
  const fail = (j: FakeJob, code: string, message: string, retryable: boolean) => {
    j.error = { code, message, retryable }; set(j, "failed", null, message);
  };

  function planSteps(cap: string, input: Record<string, any>, inFiles: Record<string, FileRef>): FakeJob["steps"] {
    const toRunning = (j: FakeJob) => set(j, "running", 0.5, "working");
    if (cap === "fake.run") {
      const n = Math.max(0, Number(input.steps ?? 1) - 1);
      const extra: FakeJob["steps"] = [];
      for (let i = 0; i < n; i++) extra.push((j: FakeJob) => set(j, "running", (i + 1) / (n + 1), `step ${i + 2}`));
      const doneEcho = (j: FakeJob) => {
        j.output = { scenario: input.scenario, echo: input.echo ?? null, answer: j.answer,
          refs: Object.keys(inFiles).filter((k) => k.startsWith("refs/")).sort() };
        j.files = inFiles.model ? { echo: { ...inFiles.model } } : {};
        for (const [k, f] of Object.entries(inFiles)) if (k.startsWith("refs/")) j.files[k] = { ...f };
        set(j, "done", 1, "done");
      };
      switch (input.scenario) {
        case "done": return [toRunning, ...extra, doneEcho];
        case "fail": return [toRunning, (j) => fail(j, "model_invalid", "scripted failure", false)];
        case "retryable": return [toRunning, (j) => fail(j, "busy", "scripted retryable failure", true)];
        case "hang": return [toRunning];
        case "needs_input": return [toRunning, (j) => {
          j.needs = { prompt: "Which of these two orientations?", input_schema: { type: "object", required: ["choice"], properties: { choice: { enum: ["a", "b"] } } } };
          j.needsSince = now();
          set(j, "needs_input", 0.5, "waiting for a person");
        }, doneEcho];
        case "needs_input_preview": return [toRunning, (j) => {
          // Like design.part: the question carries files the person should see.
          const preview = storeBytes(PNG_1PX, "image/png", "preview.png");
          const stl = storeBytes(Buffer.from("solid fake\nendsolid fake\n"), "model/stl", "part.stl");
          j.needs = {
            prompt: "The model isn't watertight. Use it anyway, or stop?",
            input_schema: { type: "object", required: ["choice"], properties: { choice: { enum: ["use_anyway", "stop"] } } },
            files: { preview, stl },
          };
          j.files = { preview, stl };
          j.needsSince = now();
          set(j, "needs_input", 0.5, "waiting for a person");
        }, (j) => {
          if ((j.answer as any)?.choice === "stop") return fail(j, "not_watertight", "stopped at the person's request", false);
          j.output = { scenario: "needs_input_preview", answer: j.answer };
          set(j, "done", 1, "done");
        }];
        case "output_bytes": return [toRunning, async (j) => {
          const f = await writeGenerated(Number(input.output_bytes ?? 0));
          j.files = { result: f };
          j.output = { scenario: "output_bytes", bytes: f.size };
          set(j, "done", 1, "done");
        }];
      }
    }
    if (cap === "fake.lookup") {
      return [(j) => {
        if (input.fail) return fail(j, "busy", "scripted: the catalog could not be reached", true);
        const q = String(input.q ?? "");
        if (!q || q === "nothing") { j.output = { items: [], total: 0 }; j.files = {}; return set(j, "done", 1, "done"); }
        const p1 = storeBytes(PNG_1PX, "image/png", "p1.png");
        const p2 = storeBytes(Buffer.from(PNG_1PX), "image/png", "p2.png");
        j.files = { "previews/p1": p1, "previews/p2": p2 };
        j.output = { items: [{ id: `${q}-1`, title: `${q} one`, preview_file: "previews/p1" }, { id: `${q}-2`, title: `${q} two`, preview_file: "previews/p2" }], total: 2 };
        set(j, "done", 1, "done");
      }];
    }
    if (cap === "slice.model") {
      return [toRunning, (j) => {
        const pm = slicePrinterModels().find((p) => p.id === input.printer_model);
        if (!pm) return fail(j, "unsupported_printer", `no profile for ${input.printer_model}`, false);
        if (!pm.nozzles.includes(input.nozzle_mm)) return fail(j, "unsupported_printer", `no ${input.nozzle_mm} mm nozzle profile`, false);
        const tools = (input.filament as unknown[]).length;
        const grams = Array.from({ length: tools }, (_, i) => (i === 0 ? 12.5 : 1.25));
        const snapshot = { printer: pm.native_name, layer_height: 0.2, filament: input.filament };
        const snapBytes = Buffer.from(JSON.stringify(snapshot));
        const is3mf = pm.output === "3mf";
        const g = storeBytes(Buffer.from(`; fake gcode for ${pm.id}\nG28\nM84\n`), "text/x.gcode", "part.gcode");
        j.files = is3mf
          ? { gcode: storeBytes(Buffer.from(`PK fake 3mf for ${pm.id}`), "model/3mf", "part.3mf"), plain_gcode: g, preview: storeBytes(PNG_1PX, "image/png", "preview.png") }
          : { gcode: g, preview: storeBytes(PNG_1PX, "image/png", "preview.png") };
        j.output = {
          estimated_seconds: 920, grams_per_tool: grams, total_grams: grams.reduce((a, b) => a + b, 0), layers: 75,
          slicer: { name: "FakeSlicer", version: "0.0.0" }, settings_snapshot: snapshot,
          profile_sha: createHash("sha256").update(snapBytes).digest("hex"),
        };
        set(j, "done", 1, "done");
      }];
    }
    // design.part
    return [toRunning, (j) => {
      const size = [40, 12.8, 15];
      const fits = Array.isArray(input.max_bbox_mm) ? size.every((v, i) => v <= (input.max_bbox_mm as number[])[i]) : undefined;
      j.files = {
        source: input.source_lang === "openscad"
          ? storeBytes(Buffer.from(String(input.source)), "text/x-openscad", "part.scad")
          : storeBytes(Buffer.from(String(input.source ?? JSON.stringify({ commands: [], template: input.template }))), "application/json", "part.solidcraft.json"),
        stl: storeBytes(Buffer.from("solid fake\nendsolid fake\n"), "model/stl", "part.stl"),
        preview: storeBytes(PNG_1PX, "image/png", "preview.png"),
      };
      j.output = {
        source_lang: input.source_lang ?? "solidcraft", params: input.params ?? {},
        report: { watertight: true, winding_consistent: true, size_mm: size, volume_mm3: 2207, z_min_on_bed: true, bodies: 1, ...(fits === undefined ? {} : { fits }) },
      };
      set(j, "done", 1, "done");
    }];
  }

  const activeCount = () => [...jobs.values()].filter((j) => !TERMINAL.has(j.status)).length;
  const runningCount = () => [...jobs.values()].filter((j) => j.status === "running" || j.status === "needs_input").length;

  async function advance(j: FakeJob) {
    if (TERMINAL.has(j.status)) return;
    if (j.status === "needs_input") {
      if (j.needsSince !== null && now() - j.needsSince > NEEDS_INPUT_TTL_MS) {
        j.error = { code: "input_timeout", message: "nobody answered within 7 days", retryable: false };
        j.needs = null;
        set(j, "cancelled", null, "input timed out");
      }
      return;
    }
    if (j.status === "queued" && runningCount() >= maxConcurrent) return;
    const step = j.steps.shift();
    if (step) await step(j);
  }

  function view(j: FakeJob) {
    return {
      job_id: j.job_id, status: j.status, progress: j.progress, message: j.message, needs: j.needs,
      output: j.output, files: j.files, error: j.error,
      poll_after_s: TERMINAL.has(j.status) ? 0 : 1,
      service_version: version, manifest_version: manifestVersion,
    };
  }

  const canonical = (v: unknown): string =>
    v === null || typeof v !== "object" ? JSON.stringify(v)
      : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
        : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;

  async function submit(req: IncomingMessage, res: ServerResponse) {
    precheck(req);
    const { body } = await readJson(req);
    stats.submits++;
    const cap = manifest.capabilities.find((c) => c.id === body.capability);
    if (!cap) throw new HttpError(400, "unsupported_input", `unknown capability ${body.capability}`);
    if (body.capability_version !== cap.version) throw new HttpError(400, "unsupported_input", `capability_version ${body.capability_version} not offered`);
    if (typeof body.idempotency_key !== "string" || !body.idempotency_key) throw new HttpError(400, "unsupported_input", "idempotency_key required");
    const input = (body.input ?? {}) as Record<string, any>;
    const files = (body.files ?? {}) as Record<string, FileRef>;
    const bodyHash = createHash("sha256").update(canonical({ c: body.capability, v: body.capability_version, i: input, f: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, f.sha256])) })).digest("hex");

    const prior = byKey.get(body.idempotency_key);
    if (prior && now() - prior.at < RETENTION_MS && jobs.has(prior.jobId)) {
      const pj = jobs.get(prior.jobId)!;
      if (pj.bodyHash !== bodyHash) throw new HttpError(409, "idempotency_conflict", "idempotency_key reused with a different body");
      sendJson(res, 202, (cap as any).mode === "sync" ? view(pj) : { job_id: pj.job_id, status: pj.status, poll_after_s: 1 });
      return;
    }
    checkFiles((cap as any).files_in ?? [], files);
    for (const [name, f] of Object.entries(files)) {
      if (!f || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new HttpError(400, "unsupported_input", `file ${name} needs a sha256`);
      if (!hasBlob(f.sha256)) throw new HttpError(400, "unsupported_input", `file ${name} (${f.sha256}) was not uploaded; PUT /blobs first`);
    }
    if (body.capability === "fake.run" && !["done", "fail", "retryable", "needs_input", "needs_input_preview", "hang", "output_bytes"].includes(input.scenario))
      throw new HttpError(400, "unsupported_input", "input.scenario must be one of the fake.run scenarios");
    if (body.capability === "design.part" && !input.source && !input.template)
      throw new HttpError(400, "unsupported_input", "one of source or template is required (this service has no LLM)");
    if (activeCount() >= queueLimit) throw new HttpError(503, "busy", `queue full (${queueLimit} jobs)`, true);

    const j: FakeJob = {
      job_id: "job_" + randomBytes(8).toString("hex"), capability: body.capability,
      status: "queued", progress: 0, message: "queued", needs: null, output: null, files: null, error: null,
      input, inFiles: files, idempotencyKey: body.idempotency_key, bodyHash,
      steps: planSteps(body.capability, input, files), createdAt: now(), finishedAt: null, needsSince: null, answer: null,
      callback: body.callback ?? null,
    };
    jobs.set(j.job_id, j);
    byKey.set(body.idempotency_key, { jobId: j.job_id, at: now() });
    stats.jobsCreated++;
    if ((cap as any).mode === "sync") {
      // §3: a sync capability's submit answer is the finished job.
      while (!TERMINAL.has(j.status) && j.steps.length) { const step = j.steps.shift()!; await step(j); }
      sendJson(res, 202, view(j));
      return;
    }
    sendJson(res, 202, { job_id: j.job_id, status: j.status, poll_after_s: 1 });
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    stats.requests++;
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (p === "/.well-known/cobblr-service.json" && m === "GET") {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(manifestBytes.length) });
      res.end(manifestBytes);
      return;
    }
    if (!p.startsWith(basePath + "/")) throw new HttpError(404, "x-not_found", "no such path");
    const rel = p.slice(basePath.length);
    let mm: RegExpExecArray | null;
    if (rel === "/health" && m === "GET") { verify(req, EMPTY_BODY_SHA256); return sendJson(res, 200, { ok: true, version, manifest_version: manifestVersion }); }
    if ((mm = /^\/capabilities\/([a-z0-9_.]+)\/options$/.exec(rel)) && m === "GET") {
      verify(req, EMPTY_BODY_SHA256);
      if (mm[1] === "slice.model") {
        const pms = slicePrinterModels();
        return sendJson(res, 200, { etag: createHash("sha256").update(JSON.stringify(pms)).digest("hex").slice(0, 16), printer_models: pms });
      }
      if (mm[1] === "design.part") {
        const templates = [{ id: "spacer", title: "Round spacer", summary: "A cylinder with a centre hole.",
          params_schema: { type: "object", required: ["od_mm", "id_mm", "height_mm"], properties: { od_mm: { type: "number", exclusiveMinimum: 0 }, id_mm: { type: "number", minimum: 0 }, height_mm: { type: "number", exclusiveMinimum: 0 } } } }];
        return sendJson(res, 200, { etag: "design-1", templates });
      }
      throw new HttpError(404, "x-not_found", "no options for that capability");
    }
    if ((mm = /^\/blobs\/([0-9a-f]{64})$/.exec(rel))) {
      if (m === "PUT") return putBlob(req, res, mm[1]);
      if (m === "HEAD") return getBlob(req, res, mm[1], true);
      if (m === "GET") return getBlob(req, res, mm[1], false);
    }
    if (rel === "/jobs" && m === "POST") return submit(req, res);
    if ((mm = /^\/jobs\/([A-Za-z0-9_-]+)$/.exec(rel)) && m === "GET") {
      verify(req, EMPTY_BODY_SHA256);
      const j = jobs.get(mm[1]);
      if (!j) throw new HttpError(404, "x-not_found", "no such job");
      if (opts.advance !== "timer") await advance(j);
      else if (j.status === "needs_input") await advance(j); // input_timeout check
      return sendJson(res, 200, view(j));
    }
    if ((mm = /^\/jobs\/([A-Za-z0-9_-]+)\/input$/.exec(rel)) && m === "POST") {
      precheck(req);
      const { body } = await readJson(req);
      const j = jobs.get(mm[1]);
      if (!j) throw new HttpError(404, "x-not_found", "no such job");
      if (j.status !== "needs_input") throw new HttpError(409, "x-wrong_state", `job is ${j.status}, not needs_input`);
      const answer = (body && typeof body === "object" && "input" in body ? body.input : body) as Record<string, unknown>;
      const choice = (answer as any)?.choice;
      const allowed: unknown[] = (j.needs?.input_schema as any)?.properties?.choice?.enum ?? [];
      if (!allowed.includes(choice)) throw new HttpError(400, "unsupported_input", `answer must match needs.input_schema: {choice: ${allowed.join("|")}}`);
      j.answer = answer; j.needs = null; j.needsSince = null;
      set(j, "running", 0.75, "answer received");
      return sendJson(res, 202, { job_id: j.job_id, status: j.status });
    }
    if ((mm = /^\/jobs\/([A-Za-z0-9_-]+)\/cancel$/.exec(rel)) && m === "POST") {
      await drainAndVerify(req);
      const j = jobs.get(mm[1]);
      if (!j) throw new HttpError(404, "x-not_found", "no such job");
      if (!TERMINAL.has(j.status)) { j.needs = null; j.steps = []; set(j, "cancelled", null, "cancelled"); }
      return sendJson(res, 202, { job_id: j.job_id, status: j.status });
    }
    throw new HttpError(405, "x-not_found", `${m} ${rel} is not part of the contract`);
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) {
        if (!req.readableEnded) req.resume();
        sendError(res, e);
      } else {
        log(`internal: ${e?.stack ?? e}`);
        sendError(res, new HttpError(500, "internal", String(e?.message ?? e), true));
      }
    });
  });

  let timer: NodeJS.Timeout | null = null;
  if (opts.advance === "timer") {
    timer = setInterval(() => { for (const j of jobs.values()) void advance(j); }, opts.timerMs ?? 100);
    timer.unref();
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  const origin = `http://${opts.host ?? "127.0.0.1"}:${addr.port}`;
  const first = initial[0];

  return {
    url: origin,
    baseUrl: origin + basePath,
    key: first,
    keyString: `${first.keyId}.${first.secret}`,
    manifest,
    manifestVersion,
    jobs,
    stats,
    mintKey() { const k = mintKey(); keys.set(k.keyId, k.secret); return k.keyString; },
    revokeKey(id) { return keys.delete(id); },
    sweep() {
      const t = now();
      const keep = new Set<string>();
      for (const [id, j] of jobs) {
        if (j.finishedAt !== null && t - j.finishedAt > RETENTION_MS) { jobs.delete(id); continue; }
        for (const f of [...Object.values(j.inFiles), ...Object.values(j.files ?? {})]) keep.add(f.sha256);
      }
      for (const [k, v] of byKey) if (t - v.at > RETENTION_MS) byKey.delete(k);
      for (const [sha, at] of blobAt) if (!keep.has(sha) && t - at > RETENTION_MS) { rmSync(blobPath(sha), { force: true }); blobAt.delete(sha); }
    },
    async close() {
      if (timer) clearInterval(timer);
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// CLI: `npx tsx conformance/ts/fake-service.ts [--port 8787] [--timer]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8787;
  const svc = await startFakeService({ port, host: "0.0.0.0", advance: process.argv.includes("--timer") ? "timer" : "poll", log: (m) => console.error(m) });
  console.log(`fake service on ${svc.url}  manifest ${svc.url}/.well-known/cobblr-service.json`);
  console.log(`key (paste into Add a service): ${svc.keyString}`);
}
