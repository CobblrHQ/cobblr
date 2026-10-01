// Thin fetch wrapper for the tracking REST surface. Auth via getToken().
// Routes mounted at /api/v1/orgs/:slug/modules/tracking/...

import { describeUnreadableBody, noteWorkspaceWrite } from "@cobblr/platform-web";

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
  /** Custom fields a bundle or a person defines for metrics. */
  metadata?: Record<string, unknown>;
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
    const url = `/api/v1/orgs/${this.slug}/modules/tracking${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const wrote = method.toUpperCase() !== "GET";
    if (res.status === 204) {
      if (wrote) noteWorkspaceWrite(url);
      return undefined as T;
    }
    let parsed: unknown;
    // TEXT first: res.json() CONSUMES the body, so once it throws the one
    // thing that says what went wrong is gone. See describeUnreadableBody.
    const raw = await res.text();
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TrackingApiError(res.status, "non_json", describeUnreadableBody(res.status, raw));
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new TrackingApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`);
    }
    if (wrote) noteWorkspaceWrite(url);
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
  /** Save custom fields on a metric; merged into what it holds. */
  setMetricFields(id: string, metadata: Record<string, unknown>) {
    return this.req<MetricSummary>("PATCH", `/metrics/${id}`, { metadata });
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
