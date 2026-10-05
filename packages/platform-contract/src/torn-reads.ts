// Reading background work that is still being written (#4890, #4893).
//
// A reader that answers "state + payload" for background work (a read, a turn,
// a session) can be TORN: it reads one, the writer finishes, it reads the
// other. The writer writes the payload first and the finished state last
// (lint:state-flips-last), and the READER must read the state first and the
// payload after, or both in one snapshot. Reading the payload first is torn
// even with a well-ordered writer: payload read empty before the writer wrote
// it, state read "ready" after the writer flipped it. That is the
// pattern-needs bug (runs 35417, 36996).
//
// readSnapshot is the order-independent way: every query inside sees the
// database as of one instant (REPEATABLE READ), so state and payload cannot
// disagree. tornInterleavings proves a reader's order against a writer by
// running it with the writer landing at every point between its reads.

/** Anything with Kysely's transaction builder: a Kysely or a tenant handle. */
export interface SnapshotCapable<Trx> {
  transaction(): { setIsolationLevel(level: "repeatable read"): { execute<T>(fn: (trx: Trx) => Promise<T>): Promise<T> } };
}

/** Run `fn` against one consistent snapshot of the database. */
export function readSnapshot<Trx, T>(db: SnapshotCapable<Trx>, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().setIsolationLevel("repeatable read").execute(fn);
}

/** A store a reader reads and a writer writes, for tornInterleavings. */
export interface WorkStore<P> {
  state: "pending" | "ready";
  payload: P;
}

/**
 * Run `reader` once for every point at which the writer can land between its
 * reads (before the first, between any two, after the last; the writer writes
 * its payload, then flips the state), and return the answers that came out
 * torn by `isTorn`. A reader whose every interleaving is clean is safe against
 * that writer. A snapshot reader reads once and so has no gap to land in.
 */
export async function tornInterleavings<P, A>(o: {
  reader: (read: { state: () => Promise<WorkStore<P>["state"]>; payload: () => Promise<P> }) => Promise<A>;
  empty: P;
  written: P;
  isTorn: (answer: A) => boolean;
}): Promise<A[]> {
  const torn: A[] = [];
  for (let landAt = 0; landAt <= 4; landAt++) {
    const store: WorkStore<P> = { state: "pending", payload: o.empty };
    let reads = 0;
    const tick = () => {
      if (reads++ === landAt) {
        store.payload = o.written;
        store.state = "ready";
      }
    };
    const answer = await o.reader({
      state: async () => {
        tick();
        return store.state;
      },
      payload: async () => {
        tick();
        return store.payload;
      },
    });
    if (o.isTorn(answer)) torn.push(answer);
  }
  return torn;
}
