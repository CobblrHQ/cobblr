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

export interface ComponentStockRow {
  id: string;
  build_id: string;
  part_id: string;
  quantity: string;
  optional: boolean;
  notes: string | null;
  name: string;
  available: number;
  per_build: number;
  max_from_this: number;
}

export interface Buildable {
  max_buildable: number;
  limiting: Array<{ part_id: string; name: string; available: number; per_build: number }>;
}

export interface BuildDetail {
  build: BuildSummary;
  components: ComponentStockRow[];
  buildable: Buildable;
}

export interface BuildRunResult {
  run: { id: string; qty_built: string; built_at: string };
  buildable: Buildable;
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
    return this.req<ComponentStockRow>("POST", `/builds/${buildId}/components`, body);
  }
  removeComponent(buildId: string, componentId: string) {
    return this.req<void>("DELETE", `/builds/${buildId}/components/${componentId}`);
  }
  build(buildId: string, qty: number) {
    return this.req<BuildRunResult>("POST", `/builds/${buildId}/build`, { qty });
  }

  /** Generic kernel entity search — inventory parts for the component picker. */
  async searchParts(q: string): Promise<PartOption[]> {
    const url = `/api/v1/orgs/${this.slug}/entities/inventory:part?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const res = await fetch(url, { headers: this.headers() });
    const data = await this.parse<{ items: Array<{ id: string; title: string; subtitle?: string }> }>(res);
    return data.items.map((i) => ({ id: i.id, title: i.title, subtitle: i.subtitle }));
  }
}
