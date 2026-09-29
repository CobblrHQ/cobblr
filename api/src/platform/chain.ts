// Who answers, in order: the one walk every "ask the next one" door shares.
//
// A call is served by the first of an ordered list of candidates (AI
// providers today; services next). The router decides the next candidate
// from the ones already asked, and two things read that decision:
//   · a call, which asks candidates in turn until one answers or a failure
//     is not one another candidate could fix (`askInOrder`);
//   · a page, which lists the whole order (`listInOrder`).
// Both walk the same `next` function, so the order a person is shown is the
// order used, by construction (#3842). What a candidate IS, and which
// failures let another one try, belong to the caller; the walk does not know.

/** What the walk keeps about a candidate it asked: the row that served it,
 *  so two connections of the same kind are two different doors. */
export interface Asked {
  rowId: string;
}

/**
 * Ask candidates in order. `attempt` resolves the next candidate from the
 * ones already asked, reports it through `current` as soon as it is known,
 * and asks it. A failure `mayAskAnother` accepts, on a call that has asked
 * fewer than `max`, records the candidate (`record`) and asks the next; any
 * other failure is thrown, dressed by `finish` with everything asked before.
 *
 * When a later candidate cannot even be resolved (nothing left, or a refusal
 * of the request itself) after an earlier one failed, the earlier failure is
 * the answer, not the refusal: "every other one was busy" reads truer than
 * "no provider".
 */
export async function askInOrder<T extends Asked, C, R>(opts: {
  max: number;
  attempt: (asked: readonly T[], current: C) => Promise<R>;
  newCurrent: () => C;
  /** The candidate `current` names, as the walk records it; null when the
   *  attempt failed before it resolved one. */
  record: (current: C, err: unknown) => T | null;
  mayAskAnother: (err: unknown) => boolean;
  /** Is this failure a candidate's own (so an earlier failure should not be
   *  replaced by it)? */
  isCandidateFailure: (err: unknown) => boolean;
  finish: (err: unknown, asked: readonly T[]) => unknown;
}): Promise<{ result: R; asked: T[]; current: C }> {
  const asked: T[] = [];
  let lastFailure: unknown = null;
  for (;;) {
    const current = opts.newCurrent();
    try {
      const result = await opts.attempt(asked, current);
      return { result, asked, current };
    } catch (err) {
      // `asked` lists the candidates asked BEFORE the one whose failure this
      // is, so the last one tried is not listed twice.
      if (lastFailure && !opts.isCandidateFailure(err)) throw opts.finish(lastFailure, asked.slice(0, -1));
      const rec = opts.record(current, err);
      if (!opts.mayAskAnother(err) || !rec || asked.length + 1 >= opts.max) throw opts.finish(err, asked);
      asked.push(rec);
      lastFailure = err;
    }
  }
}

/**
 * Every candidate a call would ask, in the order it asks them, by walking the
 * same `next` the call uses and treating each step as asked. Stops at
 * `limit`, or when `next` throws; `stoppedBy` is that error when the walk
 * found nothing at all.
 */
export async function listInOrder<T extends Asked, S, P>(opts: {
  limit: number;
  next: (asked: readonly T[]) => Promise<S>;
  step: (found: S, position: number) => Promise<{ step: P; asked: T }>;
}): Promise<{ steps: P[]; stoppedBy?: unknown }> {
  const asked: T[] = [];
  const steps: P[] = [];
  while (steps.length < opts.limit) {
    let found: S;
    try {
      found = await opts.next(asked);
    } catch (err) {
      if (!steps.length) return { steps, stoppedBy: err };
      break;
    }
    const { step, asked: a } = await opts.step(found, steps.length + 1);
    steps.push(step);
    asked.push(a);
  }
  return { steps };
}
