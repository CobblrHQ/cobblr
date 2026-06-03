// Thin fetch wrapper for the tracking REST surface. Auth via getToken().
// Routes mounted at /api/v1/orgs/:slug/modules/tracking/...

export type GoalDirection = "up" | "down" | "hit";

export interface MetricSummary {
  id: string;
  name: string;
  unit: string | null;
  goal_value: number | null;
  goal_direction: GoalDirection;
  latest_value: number | null;
  measurement_count: number;
  progress: number | null;
  created_at: string;
}

export interface Measurement {
  id: string;
  value: number;
  measured_at: string;
  note: string | null;
}

export interface MetricDetail extends Omit<MetricSummary, "measurement_count"> {
  measurements: Measurement[];
}

export class TrackingApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class TrackingApi {
  constructor(private readonly slug: string, private readonly getToken: () => string | null) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`/api/v1/orgs/${this.slug}/modules/tracking${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new TrackingApiError(res.status, "non_json", `Non-JSON response (${res.status})`);
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new TrackingApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`);
    }
    return parsed as T;
  }

  listMetrics() {
    return this.req<{ items: MetricSummary[] }>("GET", "/metrics");
  }
  getMetric(id: string) {
    return this.req<MetricDetail>("GET", `/metrics/${id}`);
  }
  createMetric(body: { name: string; unit?: string; goal_value?: number; goal_direction?: GoalDirection }) {
    return this.req<MetricSummary>("POST", "/metrics", body);
  }
  deleteMetric(id: string) {
    return this.req<void>("DELETE", `/metrics/${id}`);
  }
  logMeasurement(metricId: string, value: number, note?: string) {
    return this.req<Measurement>("POST", `/metrics/${metricId}/measurements`, { value, note });
  }
  removeMeasurement(id: string) {
    return this.req<void>("DELETE", `/measurements/${id}`);
  }
}
