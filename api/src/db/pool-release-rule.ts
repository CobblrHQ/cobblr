// The rule deciding whether a scoped caller may close a tenant pool IMMEDIATELY
// instead of waiting out the grace window. Its own module, with no env/db
// imports, so it is unit-testable without booting the api — the previous version
// of this rule lived inline in tenant.ts, was therefore never tested, and was
// wrong in a way that 500'd live requests.

/** May a scoped caller close this pool immediately?
 *
 *  Only when it is the sole reason the pool exists: its access is still the
 *  latest (nobody came after) AND the pool has been handed out exactly once
 *  since it opened (nobody came before). The old rule checked only the former,
 *  so this sequence ended a live pool under a request:
 *    1. a request gets the db (seq N) and has not run its first query yet — so
 *       it has checked out no connection and every idle guard sees it as quiet;
 *    2. a sweep gets it (seq N+1), finishes, sees seq N+1 === its own;
 *    3. it ends the pool; the request's first query hits a dead pool and 500s
 *       with "Cannot use a pool after calling end on the pool".
 */
export function mayFastClose(o: {
  /** Handouts since THIS pool generation opened (reset on open). */
  handoutsSinceOpen: number;
  /** The org's current access seq. */
  currentSeq: number | undefined;
  /** The seq captured by the scoped caller; undefined = unscoped. */
  mySeq: number | undefined;
}): boolean {
  if (o.mySeq === undefined) return false; // unscoped caller — never fast-close
  if (o.currentSeq !== o.mySeq) return false; // someone accessed after me
  return o.handoutsSinceOpen <= 1; // ...and nobody had it before me
}
