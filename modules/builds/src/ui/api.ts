// Thin fetch wrapper for the builds REST surface + a generic part lookup.
// Builds routes mount at /api/v1/orgs/:slug/modules/builds/...
// Components reference inventory parts, which builds reads through the kernel's
// generic entity endpoint (/orgs/:slug/entities/inventory:part) — the platform
// seam, never an inventory import. Works standalone; the picker is just empty
// when inventory isn't enabled.

export interface BuildSummary {
  id: string;
  name: string;
  description: string | null;
  output_part_id: string | null;
  output_qty: string;
  notes: string | null;
  created_at: string;
}

// A first-level component line: either a leaf inventory part or a sub-assembly.
export interface ComponentRow {
  id: string;
  build_id: string;
  kind: "part" | "subassembly";
  part_id: string | null;
  sub_assembly_build_id: string | null;
  quantity: string;
  optional: boolean;
  notes: string | null;
  name: string;
  per_build: number;
  // part lines only
  available?: number;
  max_from_this?: number;
  // sub-assembly lines only — how many of the sub-assembly are buildable now
  sub_max_buildable?: number;
}

export interface OperationRow {
  id: string;
  build_id: string;
  seq: number;
  name: string;
  description: string | null;
  status: "todo" | "doing" | "done" | "skipped";
  est_minutes: string | null;
  resource_module: string | null;
  resource_type: string | null;
  resource_id: string | null;
  notes: string | null;
  // Shop-floor execution rollup (rung 6) — attached by the detail endpoint.
  rollup?: OpRollup;
}

export interface OpRollup {
  actual_minutes: number;
  time_by_kind: { labor: number; machine: number; setup: number };
  good_qty: number;
  scrap_qty: number;
  rework_qty: number;
  yield_pct: number | null;
}

export interface Buildable {
  max_buildable: number;
  limiting: Array<{ part_id: string; name: string; available: number; per_build: number }>;
}

export interface BuildDetail {
  build: BuildSummary;
  components: ComponentRow[];
  buildable: Buildable;
  operations: OperationRow[];
}

export interface BuildRunResult {
  run: { id: string; qty_built: string; built_at: string };
  buildable: Buildable;
}

// Genealogy / traceability (rung 8)
export interface RunSummary {
  id: string;
  qty_built: string;
  built_at: string;
  serial_code: string | null;
}
export interface GenealogyInput {
  part_id: string;
  lot_code: string | null;
  quantity: number;
  source?: GenealogyNode;
}
export interface GenealogyNode {
  run_id: string;
  output: { part_id: string | null; serial_code: string | null; quantity: number } | null;
  inputs: GenealogyInput[];
}
export interface TraceResult {
  code: string;
  produced: Array<{ run_id: string; build_name: string; quantity: string; built_at: string }>;
  consumed: Array<{ run_id: string; build_name: string; part_id: string; quantity: string; built_at: string }>;
}

// Scheduling (rung 7)
export interface ScheduledItem {
  id: string;
  build_id: string;
  build_name: string;
  qty: number;
  due_date: string | null;
  priority: number;
  resource_label: string | null;
  est_minutes_total: number;
  projected_start: string;
  projected_finish: string;
  late: boolean;
}
export interface ScheduleLane {
  resource_label: string;
  items: ScheduledItem[];
  total_minutes: number;
  late_count: number;
}
export interface ScheduleResult {
  now: string;
  lanes: ScheduleLane[];
}

export interface PartOption {
  id: string;
  title: string;
  subtitle?: string;
}

export class BuildsApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class BuildsApi {
  constructor(private readonly slug: string, private readonly getToken: () => string | null) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    const token = this.getToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new BuildsApiError(res.status, "non_json", `Non-JSON response (${res.status})`);
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new BuildsApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`);
    }
    return parsed as T;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api/v1/orgs/${this.slug}/modules/builds${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.parse<T>(res);
  }

  listBuilds() {
    return this.req<{ items: BuildSummary[] }>("GET", "/builds");
  }
  getBuild(id: string) {
    return this.req<BuildDetail>("GET", `/builds/${id}`);
  }
  createBuild(body: { name: string; description?: string | null; output_part_id?: string | null; notes?: string | null }) {
    return this.req<BuildSummary>("POST", "/builds", body);
  }
  updateBuild(id: string, body: Partial<{ name: string; description: string | null; output_part_id: string | null; output_qty: number; notes: string | null }>) {
    return this.req<BuildSummary>("PATCH", `/builds/${id}`, body);
  }
  deleteBuild(id: string) {
    return this.req<void>("DELETE", `/builds/${id}`);
  }
  addComponent(buildId: string, body: { part_id: string; quantity: number; optional?: boolean; notes?: string | null }) {
    return this.req<ComponentRow>("POST", `/builds/${buildId}/components`, body);
  }
  addSubAssembly(buildId: string, body: { sub_assembly_build_id: string; quantity: number; optional?: boolean }) {
    return this.req<ComponentRow>("POST", `/builds/${buildId}/components`, body);
  }
  removeComponent(buildId: string, componentId: string) {
    return this.req<void>("DELETE", `/builds/${buildId}/components/${componentId}`);
  }
  build(buildId: string, qty: number, output_serial?: string) {
    return this.req<BuildRunResult>("POST", `/builds/${buildId}/build`, { qty, output_serial: output_serial || null });
  }

  // ─── genealogy / traceability (rung 8) ───
  listRuns(buildId: string) {
    return this.req<{ items: RunSummary[] }>("GET", `/builds/${buildId}/runs`);
  }
  getGenealogy(runId: string) {
    return this.req<{ tree: GenealogyNode; lineage: string[] }>("GET", `/runs/${runId}/genealogy`);
  }
  trace(code: string) {
    return this.req<TraceResult>("GET", `/trace?code=${encodeURIComponent(code)}`);
  }

  // ─── scheduling (rung 7) ───
  getSchedule() {
    return this.req<ScheduleResult>("GET", `/schedule`);
  }
  addPlanned(body: { build_id: string; qty?: number; due_date?: string | null; priority?: number; resource_label?: string | null }) {
    return this.req<unknown>("POST", `/planned`, body);
  }
  updatePlanned(pid: string, body: Partial<{ qty: number; due_date: string | null; priority: number; resource_label: string | null; status: "planned" | "done" | "cancelled" }>) {
    return this.req<unknown>("PATCH", `/planned/${pid}`, body);
  }
  removePlanned(pid: string) {
    return this.req<void>("DELETE", `/planned/${pid}`);
  }

  // ─── operations (routing) ───
  addOperation(buildId: string, body: { name: string; est_minutes?: number | null }) {
    return this.req<OperationRow>("POST", `/builds/${buildId}/operations`, body);
  }
  updateOperation(buildId: string, opId: string, body: Partial<{ name: string; status: OperationRow["status"]; seq: number; est_minutes: number | null }>) {
    return this.req<OperationRow>("PATCH", `/builds/${buildId}/operations/${opId}`, body);
  }
  removeOperation(buildId: string, opId: string) {
    return this.req<void>("DELETE", `/builds/${buildId}/operations/${opId}`);
  }

  // ─── shop-floor execution log (rung 6) ───
  logTime(buildId: string, opId: string, body: { kind?: "labor" | "machine" | "setup"; minutes: number; notes?: string | null }) {
    return this.req<unknown>("POST", `/builds/${buildId}/operations/${opId}/time`, body);
  }
  logQuantity(buildId: string, opId: string, body: { kind: "good" | "scrap" | "rework"; quantity: number; reason?: string | null }) {
    return this.req<unknown>("POST", `/builds/${buildId}/operations/${opId}/quantities`, body);
  }

  /** Generic kernel entity search — inventory parts for the component picker. */
  async searchParts(q: string): Promise<PartOption[]> {
    return this.searchEntities("inventory:part", q);
  }
  /** Generic kernel entity search — builds, for the sub-assembly picker. */
  async searchBuilds(q: string): Promise<PartOption[]> {
    return this.searchEntities("builds:build", q);
  }
  private async searchEntities(kind: string, q: string): Promise<PartOption[]> {
    const url = `/api/v1/orgs/${this.slug}/entities/${kind}?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const res = await fetch(url, { headers: this.headers() });
    const data = await this.parse<{ items: Array<{ id: string; title: string; subtitle?: string }> }>(res);
    return data.items.map((i) => ({ id: i.id, title: i.title, subtitle: i.subtitle }));
  }
}
