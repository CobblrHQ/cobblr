// The dashboard in one answer (#6563): every registered section's reads
// (@cobblr/platform-contract/dashboard-reads), each through the api's own
// route as the caller, in parallel, close to the database. A read keeps its
// route's status: a 403 the caller would have met is in the snapshot as a
// 403, so the client meets it exactly as before.
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";
import { dashboardReads, snapshotKey, type DashboardReadContext, type DashboardSnapshot, type SnapshotEntry } from "@cobblr/platform-contract/dashboard-reads";

/** A section whose read hangs is left out (its own request then asks), never
 *  the reason the whole page waits. */
export const READ_TIMEOUT_MS = 4_000;
/** Reads in flight at once: the snapshot shares the database with everyone. */
export const READ_CONCURRENCY = 12;

export interface ComposeInput {
  slug: string;
  today: string;
  upNext: { from: string; to: string } | null;
  enabled: ReadonlySet<string>;
  /** The caller's own credentials, carried to every read. */
  headers: Record<string, string>;
}

/** All reads, including lookups used to name other reads, share this queue. */
function readQueue(n: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return <T>(read: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const start = async () => {
      active++;
      try {
        resolve(await read());
      } catch (err) {
        reject(err);
      } finally {
        active--;
        waiting.shift()?.();
      }
    };
    if (active < n) void start();
    else waiting.push(() => void start());
  });
}

export async function composeDashboardSnapshot(input: ComposeInput): Promise<DashboardSnapshot> {
  const origin = selfOrigin();
  const prefix = `/orgs/${input.slug}/`;
  const runRead = readQueue(READ_CONCURRENCY);
  const answers = new Map<string, Promise<SnapshotEntry | null>>();
  // One answer per path per snapshot: a path two sections read, or one a
  // section reads to name its others, is asked once.
  const fetchOnce = (path: string): Promise<SnapshotEntry | null> => {
    const key = snapshotKey(path);
    let p = answers.get(key);
    if (!p) {
      p = runRead(async () => {
        try {
          const r = await apiFetch(`${origin}/api/v1${path}`, { headers: input.headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
          const text = await r.text();
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            return null;
          }
          return { status: r.status, body };
        } catch {
          return null;
        }
      });
      answers.set(key, p);
    }
    return p;
  };
  const ctx: DashboardReadContext = {
    slug: input.slug,
    today: input.today,
    upNext: input.upNext,
    enabled: input.enabled,
    read: async <T>(path: string) => {
      const e = await fetchOnce(path);
      return e && e.status < 400 ? (e.body as T) : null;
    },
  };
  const reads = dashboardReads().filter((r) => !r.module || input.enabled.has(r.module));
  await Promise.all(reads.map(async (r) => {
    const named = (await Promise.resolve(r.paths(ctx)).catch(() => [] as string[])) ?? [];
    // Only this workspace's own paths: a section cannot name another workspace.
    const paths = named.filter((p) => p.startsWith(prefix)).map(snapshotKey);
    await Promise.all(paths.map(fetchOnce));
  }));
  const entries: Record<string, SnapshotEntry> = {};
  for (const [key, p] of answers) {
    const e = await p;
    if (e) entries[key] = e;
  }
  return { at: new Date().toISOString(), entries };
}
