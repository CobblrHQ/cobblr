// Which entity kinds' list resolvers FAILED recently, readable on /healthz.
//
// A list resolver that throws is caught by entities.list(), which answers
// `failed: true` to its caller and logs one line. For three weeks the search
// columns of two kinds named columns their tables do not have; the hosted product
// logged the failure 52 times in 72 hours and nothing read the log, because a
// log leaves with the container and no deploy reader looks at it (#3824). The
// deploy readers already read /healthz on every surface (errors_5xx_5m,
// sweeps_failing), so the failures are counted here, in-process, and served
// beside those: a kind that keeps failing is then a red line in deploy-gap.sh
// on whichever box it happens, the same way a failing sweep is.

const WINDOW_MS = 60 * 60_000;

interface Failure {
  at: number;
  error: string;
}

const byKind = new Map<string, Failure[]>();

/** Note one failed list for `kind`. Bounded: at most 50 kept per kind. */
export function noteResolverFailure(kind: string, err: unknown): void {
  const list = byKind.get(kind) ?? [];
  list.push({ at: Date.now(), error: String((err as Error)?.message ?? err).slice(0, 200) });
  if (list.length > 50) list.splice(0, list.length - 50);
  byKind.set(kind, list);
}

/** The kinds whose list failed in the last hour, most failures first. */
export function failingResolvers(now = Date.now()): Array<{ kind: string; count: number; last_at: string; error: string }> {
  const out: Array<{ kind: string; count: number; last_at: string; error: string }> = [];
  for (const [kind, list] of byKind) {
    const recent = list.filter((f) => now - f.at <= WINDOW_MS);
    if (recent.length === 0) continue;
    const last = recent[recent.length - 1]!;
    out.push({ kind, count: recent.length, last_at: new Date(last.at).toISOString(), error: last.error });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** For tests. */
export function _resetResolverFailures(): void {
  byKind.clear();
}
