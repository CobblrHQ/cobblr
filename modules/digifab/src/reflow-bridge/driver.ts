import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseReflowProfile, yarcProfile, type ReflowProfile, type ReflowSample } from "@cobblr/platform-contract/reflow-profile";
import { openReflowTransport, type ReflowTransport } from "./transport.js";
interface Reply { ok: boolean; detail?: string; data?: Record<string, unknown> }
interface Run { run_id: string; profile_hash: string; started_at: string; state: "running" | "completed" | "interrupted" | "uncertain"; samples: ReflowSample[]; controller_started: boolean; detail?: string }
interface Dependencies { open?: typeof openReflowTransport; fetch?: typeof fetch; now?: () => number; socket?: (url: string) => WebSocket }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error("Choose a valid run id."); return value; };
export class ReflowBridgeDriver {
  private transport: ReflowTransport | null = null;
  private socket: WebSocket | null = null;
  private opening: Promise<ReflowTransport> | null = null;
  private buffer = "";
  private observers = new Set<(line: string) => void>();
  private pending: { profile: ReflowProfile; hash: string; slot?: number; controller_name?: string } | null = null;
  private run: Run | null = null;
  private mode: string | null = null;
  private busy = false;
  private generation = 0;
  private cancellations = new Set<() => void>();
  private closed = false;
  private epoch = 0;
  private readonly directory: string;
  private readonly model: "t962-ue" | "yarc";
  private readonly timeoutMs: number;
  private readonly base: string;
  constructor(private config: Record<string, unknown>, private deps: Dependencies = {}) {
    if (config.model !== "t962-ue" && config.model !== "yarc") throw new Error("Choose T-962 UnifiedEngineering firmware or YARC.");
    this.model = config.model;
    this.timeoutMs = Number(config.timeoutMs || 5000);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 50 || this.timeoutMs > 30000) throw new Error("Give a controller timeout between 50 and 30000 milliseconds.");
    this.base = String(config.url || "").replace(/\/+$/, "");
    if (this.model === "yarc") { const url = new URL(this.base); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Give the YARC HTTP address without credentials."); }
    const identity = digest({ model: this.model, host: config.host, port: config.port, path: config.path, url: this.base });
    this.directory = config.stateDirectory ? String(config.stateDirectory) : join(homedir(), ".cobblr", "reflow", identity);
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private async connect(): Promise<ReflowTransport> {
    if (this.closed) throw new Error("The controller connection was removed.");
    if (this.transport) return this.transport;
    if (!this.opening) this.opening = (this.deps.open ?? openReflowTransport)(this.config).then(async transport => {
      if (this.closed) { await transport.close(); throw new Error("The controller connection was removed."); }
      this.transport = transport;
      transport.stream.on("data", bytes => {
        this.buffer += String(bytes);
        if (this.buffer.length > 65536) { this.failed("The serial report exceeds its limit."); transport.stream.destroy(); return; }
        let end: number;
        while ((end = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, end).replace(/\r$/, "").trim(); this.buffer = this.buffer.slice(end + 1); this.line(line); for (const observer of this.observers) observer(line); }
      });
      transport.stream.on("error", () => this.failed("The controller connection failed. Check the oven before continuing."));
      transport.stream.on("close", () => { if (this.transport === transport) this.transport = null; if (!this.closed) this.failed("The controller disconnected. Check the oven before continuing."); });
      return transport;
    }).finally(() => { this.opening = null; });
    return this.opening;
  }
  private failed(detail: string) { this.pending = null; if (this.run?.state === "running") { this.run.state = "uncertain"; this.run.detail = detail; } }
  private sample(celsius: number) {
    if (!this.run || !["running", "completed"].includes(this.run.state) || !Number.isFinite(celsius) || celsius < -20 || celsius > 400) return;
    const seconds = (this.now() - this.epoch) / 1000;
    if (seconds < 0 || seconds > 14400 || this.run.samples.length >= 50000) { this.failed("The run exceeded its recording limit."); return; }
    if (this.run.samples.length && seconds <= this.run.samples.at(-1)!.seconds) return;
    this.run.samples.push({ seconds, celsius });
  }
  private line(line: string) {
    const columns = line.split(",").map(v => v.trim());
    if (columns.length === 11 && ["STANDBY", "REFLOW", "BAKE"].includes(columns[10]!) && columns.slice(0, 10).every(v => v !== "" && Number.isFinite(Number(v)))) {
      this.mode = columns[10]!;
      if (this.run && this.mode === "REFLOW") this.run.controller_started = true;
      if (this.mode === "REFLOW" || this.run?.controller_started) this.sample(Number(columns[6]));
    }
    if (/^Reflow done$/i.test(line) && this.run?.controller_started && this.run.state === "running") this.run.state = "completed";
    if (/Reflow interrupted|Stopping bake\/reflow/i.test(line) && this.run?.state === "running") this.run.state = "interrupted";
  }
  private async request(command: string, match: (line: string) => boolean, generation?: number): Promise<void> {
    const transport = await this.connect();
    if (generation !== undefined && generation !== this.generation) throw new Error("Start was cancelled by Stop.");
    await new Promise<void>((resolve, reject) => {
      const done = (e?: Error) => { clearTimeout(timer); this.observers.delete(observe); this.cancellations.delete(cancel); e ? reject(e) : resolve(); };
      const cancel = () => done(new Error("Start was cancelled by Stop."));
      const observe = (line: string) => { try { if (match(line)) done(); } catch (e) { done(e as Error); } };
      const timer = setTimeout(() => done(new Error("The controller did not confirm the command. Check it at the oven.")), this.timeoutMs);
      if (generation !== undefined) this.cancellations.add(cancel);
      this.observers.add(observe); void transport.write(command).catch(e => done(e as Error));
    });
  }
  private async persistReceipt(run: Run): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(join(this.directory, `${run.run_id}.json`), "wx", 0o600).catch(e => { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This run already has a Start receipt. Check the oven; never resend its Start."); throw e; });
    try { await file.writeFile(JSON.stringify({ ...run, samples: [], state: "uncertain" })); await file.sync(); } finally { await file.close(); }
  }
  private async stored(runId: string): Promise<Run | null> {
    try { return JSON.parse(await readFile(join(this.directory, `${uuid(runId)}.json`), "utf8")) as Run; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  private async checkpoint() { if (this.run) await writeFile(join(this.directory, `${this.run.run_id}.json`), JSON.stringify(this.run), { mode: 0o600 }); }
  async runCommand(command: string, params: Record<string, unknown>): Promise<Reply> {
    if (command === "reflow.status") {
      const runId = uuid(params.run_id), run = this.run?.run_id === runId ? this.run : await this.stored(runId);
      if (!run) throw new Error("This bridge has no receipt for that reflow run.");
      await this.checkpoint(); return { ok: true, data: { ...run, state: run !== this.run && run.state === "running" ? "uncertain" : run.state, last_mode: this.mode } };
    }
    if (command === "reflow.stop") {
      this.generation++; this.pending = null;
      for (const cancel of [...this.cancellations]) cancel();
      if (this.run) this.run.state = "interrupted";
      if (this.model === "yarc") { this.socket?.close(); this.socket = null; await this.checkpoint(); return { ok: true, detail: "Monitoring stopped. Stop YARC at its oven controls." }; }
      await this.request("stop", line => /^Stopping bake\/reflow/i.test(line));
      await this.checkpoint(); return { ok: true };
    }
    if (this.busy) throw new Error("The oven is already handling a command.");
    this.busy = true;
    try {
      if (command === "reflow.prepare") {
        if (this.run?.state === "running" || this.run?.state === "uncertain") throw new Error("The previous run is still running or uncertain. Check and stop the oven first.");
        const profile = parseReflowProfile(params.profile), hash = digest(profile);
        if (this.model === "yarc") {
          const response = await (this.deps.fetch ?? fetch)(`${this.base}/create-profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(yarcProfile(profile)), signal: AbortSignal.timeout(this.timeoutMs) });
          if (!response.ok || digest(await response.json()) !== digest(yarcProfile(profile))) throw new Error("YARC did not confirm the uploaded profile.");
          this.pending = { profile, hash }; return { ok: true, data: { profile_hash: hash, manual_start: true } };
        }
        const slot = Number(params.slot), controller_name = String(params.controller_name || "");
        if (!Number.isInteger(slot) || slot < 0 || slot > 127 || !controller_name || controller_name.length > 80) throw new Error("Choose a listed firmware profile slot and its exact name.");
        await this.request("about", line => /T-962-controller open source firmware|T-962 improved reflow oven/i.test(line));
        const slots = new Map<number, string>(); let listed = false;
        await this.request("list profiles", line => { const found = /^(\d+):\s*(.+)$/.exec(line); if (found) { slots.set(Number(found[1]), found[2]!); listed = true; } return listed && line === ""; });
        if (slots.get(slot) !== controller_name) throw new Error("The requested profile slot and name are not in this firmware's list.");
        await this.request(`select profile ${slot}`, line => { const selected = /^Selected profile (\d+):\s*(.+)$/.exec(line); if (!selected) return false; if (Number(selected[1]) !== slot || selected[2] !== controller_name) throw new Error("The selected firmware profile differs from the requested slot."); return true; });
        if (this.mode !== "STANDBY") throw new Error("The controller has not reported standby. Check it before Start.");
        this.pending = { profile, hash, slot, controller_name }; return { ok: true, data: { profile_hash: hash, slot, controller_name, manual_start: false } };
      }
      if (command === "reflow.start" && this.model === "yarc") throw new Error("YARC starts at the oven. Use manual Start with bridge monitoring.");
      if (command === "reflow.start" || command === "reflow.monitor") {
        const run_id = uuid(params.run_id), generation = this.generation;
        if (await this.stored(run_id)) throw new Error("This run already has a Start receipt. Do not repeat its heat command.");
        if (!this.pending || params.profile_hash !== this.pending.hash) throw new Error("Prepare and verify this profile before Start.");
        if (this.run?.state === "running" || this.model === "t962-ue" && this.mode !== "STANDBY") throw new Error("The oven is already running or has not reported standby.");
        if (command === "reflow.monitor" && this.model !== "yarc") throw new Error("Monitoring Start is only for YARC's physical oven control.");
        const pending = this.pending;
        this.run = { run_id, profile_hash: pending.hash, started_at: new Date(this.now()).toISOString(), state: "running", samples: [], controller_started: false };
        await this.persistReceipt(this.run); this.epoch = this.now();
        if (generation !== this.generation) throw new Error("Start was cancelled by Stop.");
        if (this.model === "t962-ue") {
          try { await this.request("reflow", line => line === `Starting reflow with profile: ${pending.controller_name}`, generation); }
          catch (e) { if (generation !== this.generation) { await this.checkpoint(); throw e; } this.run.state = "uncertain"; this.run.detail = "Start was sent without confirmation. Check the oven before doing anything else."; await this.checkpoint(); throw e; }
        } else {
          const ws = new URL(this.base); ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:"; ws.pathname = "/ws";
          const socket = (this.deps.socket ?? (url => new WebSocket(url)))(ws.toString()); this.socket = socket;
          await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("YARC monitoring did not connect.")), this.timeoutMs); socket.addEventListener("open", () => { clearTimeout(timer); socket.send("startMonitoring"); resolve(); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("YARC monitoring failed.")); }, { once: true }); });
          socket.addEventListener("message", event => { const values = String(event.data).split(";"); if (values.length === 3 && /^\d{2}:\d{2}$/.test(values[0]!)) { this.run!.controller_started = true; this.sample(Number(values[2])); } });
          socket.addEventListener("close", () => { if (this.socket === socket && this.run?.state === "running") this.failed("YARC monitoring disconnected. Check the oven."); });
        }
        if (generation !== this.generation) throw new Error("Start was cancelled by Stop.");
        await this.checkpoint(); return { ok: true, data: { run_id, profile_hash: this.run.profile_hash } };
      }
      throw new Error("This reflow driver does not support that command.");
    } finally { this.busy = false; }
  }
  async listDevices() { return [{ id: "oven", name: String(this.config.name || "Reflow oven"), state: this.run?.state === "running" ? "printing" : this.run?.state === "uncertain" ? "unknown" : "idle", enabled: !this.closed }]; }
  async uploadFile(_bytes: Uint8Array, _filename: string): Promise<{ fileId: string }> { throw new Error("Reflow profiles use the declared prepare command."); }
  async submitJob(_fileId: string): Promise<{ jobId: string; queued: boolean }> { throw new Error("Start reflow only from its authorized station."); }
  async getJobStatus(jobId: string) { const result = await this.runCommand("reflow.status", { run_id: jobId }); return { state: String(result.data!.state) }; }
  async close() { this.closed = true; this.pending = null; this.socket?.close(); this.socket = null; if (this.run?.state === "running") { this.run.state = "uncertain"; this.run.detail = "The bridge stopped during this run. Check the oven before continuing."; await this.checkpoint(); } await this.transport?.close(); this.transport = null; }
}
export default { kind: "cobblr-reflow", name: "Cobblr reflow controllers", apiVersion: 1, summary: "T-962 UnifiedEngineering serial control and YARC profile upload with monitoring.", createDriver: (config: Record<string, unknown>) => new ReflowBridgeDriver(config) };
