// What the dashboard reads, said once on the server (#6563).
//
// The dashboard drew in five waves: about forty requests, each section on
// screen when its own answer landed, the page growing and shrinking as they
// did. Now the server answers them all in one response
// (GET /orgs/:slug/dashboard): every section that draws there registers the
// GET paths it reads, and the snapshot reads each through the api's own
// route, as the caller, so a section's answer is exactly what its own request
// would have been (its rules, its role checks, its shape). The client's GET
// layer answers those paths from the snapshot (platform-web primed-reads), so
// a section keeps its own query and does not know the snapshot exists.
//
// A module that draws a dashboard tile registers its reads at boot, beside
// the tile: a module adds its section without the host knowing it.

/** What a dashboard read is given to name its paths. */
export interface DashboardReadContext {
  /** The workspace, as its paths spell it. */
  slug: string;
  /** The reader's own day (YYYY-MM-DD): "today" is theirs, not the server's. */
  today: string;
  /** The window the reader's Up next asks for, as the client computes it. */
  upNext: { from: string; to: string } | null;
  /** The modules turned on in this workspace. */
  enabled: ReadonlySet<string>;
  /** Another path's answer (read once per snapshot and kept in it), for a
   *  read whose paths depend on one: the instances whose tiles draw, the
   *  views pinned to the page. null when it could not be read. */
  read<T = unknown>(path: string): Promise<T | null>;
}

export interface DashboardRead {
  /** `<module>.<what>`, unique. */
  id: string;
  /** Only in workspaces with this module on. Absent: every workspace. */
  module?: string;
  /** The GET paths this section reads, "/orgs/<slug>/…", exactly as the
   *  client asks for them (query and all). */
  paths(ctx: DashboardReadContext): string[] | Promise<string[]>;
}

const KEY = Symbol.for("cobblr.dashboard-reads");
type Store = Map<string, DashboardRead>;
const store = (): Store => ((globalThis as Record<symbol, Store>)[KEY] ??= new Map());

/** Register a section's reads. Registering the same id again replaces it. */
export function registerDashboardRead(read: DashboardRead): void {
  store().set(read.id, read);
}

export function dashboardReads(): DashboardRead[] {
  return [...store().values()];
}

/** A collection tile's reads, as the host draws one (web/src/dashboard/
 *  builtinWidgets.tsx, a module's DashboardWidget): its counts, its
 *  instances and each named instance's counts, and the one-record probe the
 *  page asks to know whether the workspace holds anything yet. `base` is the
 *  module's own path for its default collection ("machines/machines"). */
export async function collectionTileReads(ctx: DashboardReadContext, module: string, base: string): Promise<string[]> {
  const { slug, read } = ctx;
  const insts = (await read<{ items: Array<{ instance_name: string; is_default: boolean }> }>(`/orgs/${slug}/instances?module=${module}`))?.items ?? [];
  return [
    `/orgs/${slug}/modules/${base}/dashboard`,
    `/orgs/${slug}/modules/${base}?limit=1`,
    `/orgs/${slug}/instances?module=${module}`,
    // registry-filter-ok: the default collection is counted by its module path above; a tile lists the named ones
    ...insts.filter((i) => !i.is_default && i.instance_name !== module).map((i) => `/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items/dashboard`),
  ];
}

/** One spelling of a path for matching a request to a snapshot entry: the
 *  query's keys in order, so `?to=…&from=…` and `?from=…&to=…` are one read. */
export function snapshotKey(path: string): string {
  const q = path.indexOf("?");
  if (q < 0) return path;
  const params = new URLSearchParams(path.slice(q + 1));
  params.sort();
  const s = params.toString();
  return s ? `${path.slice(0, q)}?${s}` : path.slice(0, q);
}

/** One entry of the snapshot: the status and body the route answered. */
export interface SnapshotEntry {
  status: number;
  body: unknown;
}

export interface DashboardSnapshot {
  /** When the server composed it (ISO). */
  at: string;
  /** By snapshotKey(path). */
  entries: Record<string, SnapshotEntry>;
  /** A read left out of `entries`, by snapshotKey(path), and why: `timeout`
   *  when it ran past the snapshot's limit (slow, so its section asks on its
   *  own), `failed` when it never answered or answered something unreadable. */
  missed?: Record<string, SnapshotMiss>;
}

export type SnapshotMiss = "timeout" | "failed";
