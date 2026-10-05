// What the heal, reconcile and sweep passes caught and carried on past.
//
// Every per-workspace or per-module pass catches its failures (one workspace
// that cannot be read must never stop boot, or the round), and each used to
// log a line and return exactly as if nothing had happened. A test that saw
// "the field did not arrive" could not tell a skipped workspace from a write
// that failed (#4937); an operator could not tell a quiet deployment from one
// whose heals failed every round, short of reading every boot log.
//
// So a pass's catch records here (platform().health.notePassFailure), beside
// the log line it already writes: kept, a few per pass, for /healthz, /readyz
// and the test-support door. lint:pass-failures-reported holds every catch in
// a pass to recording, or to rethrowing, or to saying why neither applies.

export interface PassFailure {
  /** What failed and where, newest first. */
  last: Array<{ scope: string | null; error: string; at: string }>;
  /** Every failure this process has recorded for the pass. */
  count: number;
}

const KEPT = 5;
const failures = new Map<string, PassFailure>();

/** Record what a pass caught. The caller still logs it; this keeps it. Never
 *  throws. */
export function notePassFailure(pass: string, scope: string | null, err: unknown): void {
  const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const f = failures.get(pass) ?? { last: [], count: 0 };
  f.count++;
  f.last.unshift({ scope, error, at: new Date().toISOString() });
  f.last.length = Math.min(f.last.length, KEPT);
  failures.set(pass, f);
}

/** Every pass that failed somewhere, by name. */
export function passFailures(): Record<string, PassFailure> {
  return Object.fromEntries([...failures].map(([k, v]) => [k, { count: v.count, last: [...v.last] }]));
}

/** Tests only: start from nothing. */
export function clearPassFailures(): void {
  failures.clear();
}
