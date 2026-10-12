// What each kind of request costs this deployment (#5424): wall time, CPU and memory growth per route,
// and how often one workspace calls it in a day. The question it answers is the business-models rule
// (2): does a feature cost us per use, enough to run it on the client, limit it per workspace or meter it?
// Nobody can answer that from the request log: production's says which route, never how long or how hard.
//
// In memory, since the api started: a restart (every release) starts it again, and `since` says when.
// Counts and distributions only: a workspace is a key in a per-day tally and never leaves this file.
//
// CPU is the process's, so a request that overlapped another is charged for both. Each request knows
// whether anything else ran while it did; `cpu_ms` is read from the ones that ran alone, and
// `cpu_ms_overlapped` from the rest (an upper bound). Worker threads (nesting) are in the process's CPU.

const MAX_ROUTES = 400;
const SAMPLES = 500;

interface RouteTally {
  calls: number;
  wall: number[];
  cpuSolo: number[];
  cpuOverlapped: number[];
  cpuTotal: number;
  rssGrowthMax: number;
  errors: number;
  perWorkspaceDay: Map<string, Map<string, number>>;
  seen: number;
}

const routes = new Map<string, RouteTally>();
let since = new Date();
let inFlight = 0;
let started = 0;

/** A route's shape, not its address: ids, numbers and the workspace become placeholders. */
export function routeTemplate(method: string, url: string): string {
  const path = (url.split("?")[0] ?? "").replace(/^\/api\/v1(?=\/|$)/, "") || "/";
  const out: string[] = [];
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] ?? "";
    const prev = parts[i - 1];
    if (!seg) out.push(seg);
    else if (prev === "orgs" || prev === "w") out.push(":org");
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) out.push(":id");
    else if (/^\d+$/.test(seg)) out.push(":n");
    else if (seg.length >= 20 && /\d/.test(seg)) out.push(":key");
    else out.push(seg.length > 40 ? ":long" : seg);
  }
  return `${method.toUpperCase()} ${out.join("/")}`;
}

/** The workspace a request is for, from /orgs/<slug>/…; null for one that names none. */
export function workspaceOf(url: string): string | null {
  const m = /\/(?:orgs|w)\/([^/?]+)/.exec(url);
  return m?.[1] ?? null;
}

const keep = (a: number[], v: number) => {
  if (a.length >= SAMPLES) a[Math.floor(Math.random() * SAMPLES)] = v;
  else a.push(v);
};

/** Start timing one request; the returned function records it when the response is done. */
export function startRequest(method: string, url: string): (status: number) => void {
  const t0 = process.hrtime.bigint();
  const c0 = process.cpuUsage();
  const r0 = process.memoryUsage.rss();
  const startedBefore = started++;
  const alone = inFlight === 0;
  inFlight++;
  let done = false;
  return (status: number) => {
    if (done) return;
    done = true;
    inFlight--;
    const overlapped = !alone || started - startedBefore > 1;
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const c = process.cpuUsage(c0);
    const cpuMs = (c.user + c.system) / 1000;
    const growth = Math.max(0, process.memoryUsage.rss() - r0);
    record(routeTemplate(method, url), workspaceOf(url), { wallMs, cpuMs, overlapped, rssGrowth: growth, failed: status >= 500 });
  };
}

export function record(
  key: string,
  workspace: string | null,
  m: { wallMs: number; cpuMs: number; overlapped: boolean; rssGrowth: number; failed: boolean },
  // UTC-DAY OK: an operator's tally bucket, nobody's calendar; the same day for every workspace keeps them comparable
  day = new Date().toISOString().slice(0, 10),
): void {
  let t = routes.get(key);
  if (!t) {
    if (routes.size >= MAX_ROUTES) key = "other";
    t = routes.get(key);
    if (!t) {
      t = { calls: 0, wall: [], cpuSolo: [], cpuOverlapped: [], cpuTotal: 0, rssGrowthMax: 0, errors: 0, perWorkspaceDay: new Map(), seen: 0 };
      routes.set(key, t);
    }
  }
  t.calls++;
  keep(t.wall, m.wallMs);
  keep(m.overlapped ? t.cpuOverlapped : t.cpuSolo, m.cpuMs);
  t.cpuTotal += m.cpuMs;
  t.rssGrowthMax = Math.max(t.rssGrowthMax, m.rssGrowth);
  if (m.failed) t.errors++;
  if (workspace) {
    let days = t.perWorkspaceDay.get(day);
    if (!days) {
      days = new Map();
      t.perWorkspaceDay.set(day, days);
      // Two days are enough for "calls per workspace per day"; older ones go.
      const order = [...t.perWorkspaceDay.keys()].sort();
      while (order.length > 2) t.perWorkspaceDay.delete(order.shift()!);
    }
    days.set(workspace, (days.get(workspace) ?? 0) + 1);
  }
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}
const spread = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return { p50: round(pct(s, 0.5)), p95: round(pct(s, 0.95)), max: round(s.at(-1) ?? 0), samples: s.length };
};
const round = (n: number) => Math.round(n * 10) / 10;

export interface ComputeRow {
  route: string;
  calls: number;
  errors_5xx: number;
  wall_ms: { p50: number; p95: number; max: number; samples: number };
  cpu_ms: { p50: number; p95: number; max: number; samples: number };
  cpu_ms_overlapped: { p50: number; p95: number; max: number; samples: number };
  cpu_share: number;
  rss_growth_max_mb: number;
  per_workspace_day: { workspaces: number; p50: number; p95: number; max: number };
}

/** Every route seen since the api started, the heaviest by total CPU first. */
export function computeStats(limit = 60): { since: string; uptime_s: number; routes_seen: number; cpu_total_ms: number; rows: ComputeRow[] } {
  const total = [...routes.values()].reduce((s, t) => s + t.cpuTotal, 0);
  const rows = [...routes.entries()]
    .map(([route, t]): ComputeRow => {
      const perDay = [...t.perWorkspaceDay.values()].flatMap((d) => [...d.values()]).sort((a, b) => a - b);
      return {
        route,
        calls: t.calls,
        errors_5xx: t.errors,
        wall_ms: spread(t.wall),
        cpu_ms: spread(t.cpuSolo),
        cpu_ms_overlapped: spread(t.cpuOverlapped),
        cpu_share: total ? Math.round((t.cpuTotal / total) * 1000) / 1000 : 0,
        rss_growth_max_mb: round(t.rssGrowthMax / 1024 / 1024),
        per_workspace_day: { workspaces: new Set([...t.perWorkspaceDay.values()].flatMap((d) => [...d.keys()])).size, p50: pct(perDay, 0.5), p95: pct(perDay, 0.95), max: perDay.at(-1) ?? 0 },
      };
    })
    .sort((a, b) => b.cpu_share - a.cpu_share || b.calls - a.calls)
    .slice(0, Math.max(1, Math.min(400, limit)));
  return { since: since.toISOString(), uptime_s: Math.round(process.uptime()), routes_seen: routes.size, cpu_total_ms: Math.round(total), rows };
}

/** For a test: start again. */
export function resetComputeLedger(): void {
  routes.clear();
  since = new Date();
  inFlight = 0;
  started = 0;
}
