// Who is busy, remembered.
//
// A provider that answers "high demand" for twenty minutes was asked again on
// every call, and every call paid the failed attempt (and its retries) before
// reaching the model that worked (2026-10-02: every Flash alias returned 503
// on page-sized requests while a pinned older Flash answered). So a busy
// answer puts that model in a cool-down, and the next call starts on the rung
// that works.
//
// Keyed by the credential row, the model and the JOB: busy is per request
// size, and a short chat answering on a model says nothing about whether a
// page-sized document read will. So only a real success of the same job on
// the same model clears it; a small probe never does.
//
// In this process's memory: a restart forgets, which costs one failed attempt
// per busy model, never a wrong answer. Shared by every call this process
// makes for the workspace, which is where the repeated cost was.

export const COOL_DOWN_FIRST_MS = 5 * 60_000;
export const COOL_DOWN_MAX_MS = 30 * 60_000;

interface Cooling {
  until: number;
  /** Busy answers in a row, for the doubling. */
  strikes: number;
}

const cooling = new Map<string, Cooling>();
let now = () => Date.now();

const keyOf = (rowId: string, model: string, capability: string) => `${rowId}|${model}|${capability}`;

/** Whether this model is cooling down for this job on this credential. */
export function isCooling(rowId: string, model: string, capability: string): boolean {
  const c = cooling.get(keyOf(rowId, model, capability));
  return !!c && c.until > now();
}

/** A busy answer: cool down for 5 minutes, doubling with each busy answer
 *  in a row, up to 30. Returns how long, for the log. */
export function noteBusy(rowId: string, model: string, capability: string): number {
  const key = keyOf(rowId, model, capability);
  const strikes = (cooling.get(key)?.strikes ?? 0) + 1;
  const ms = Math.min(COOL_DOWN_FIRST_MS * 2 ** (strikes - 1), COOL_DOWN_MAX_MS);
  cooling.set(key, { until: now() + ms, strikes });
  return ms;
}

/** A real answer from this model for this job: it is free again. */
export function noteAnswered(rowId: string, model: string, capability: string): void {
  cooling.delete(keyOf(rowId, model, capability));
}

export function setCoolDownClockForTest(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

export function clearCoolDownsForTest(): void {
  cooling.clear();
}
