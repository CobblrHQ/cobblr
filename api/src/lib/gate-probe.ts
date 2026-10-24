// Asking a route whether a person may do something, without doing it.
//
// An assistant's DELETE is held for its person (ai-held-changes.ts), and the
// hold used to come before the route's own gate: a member's assistant asked
// to delete a part only an owner may delete, the member was sent "Delete it?",
// pressed it, and was refused (#7909). The gate lives in each route, so the
// hold asks it: the request is replayed as the person, marked as a probe, and
// the probe ends the moment the route passes its gate (a role or capability
// check passing) or reaches its first write, before that write runs. A route
// that refuses first answers as it always would, and that refusal is the
// assistant's answer, with no card. Every stop errs toward the hold: a probe
// stopped early only means the person is asked, as before.

import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface GateProbe {
  /** The route got past its gate: the person may, so the hold goes ahead. */
  passed: boolean;
  /** Set once the probe has stopped or answered; nothing after it is stopped. */
  done: boolean;
}

/** Thrown at a stop point; the app's error handler answers it quietly. */
export class GateProbeStop extends Error {
  constructor() {
    super("gate probe: the route passed its gate");
    this.name = "GateProbeStop";
  }
}

export const GATE_PROBE_HEADER = "x-cobblr-gate-probe";

const waiting = new Map<string, GateProbe>();
const storage = new AsyncLocalStorage<GateProbe>();

/** A fresh probe and the mark its request carries. One use, in this process. */
export function openGateProbe(): { mark: string; probe: GateProbe } {
  const mark = randomBytes(24).toString("hex");
  const probe: GateProbe = { passed: false, done: false };
  waiting.set(mark, probe);
  setTimeout(() => waiting.delete(mark), 60_000).unref();
  return { mark, probe };
}

/** The probe a request's mark names, taken so it cannot be used twice. */
export function takeGateProbe(mark: string | undefined): GateProbe | null {
  if (!mark) return null;
  const probe = waiting.get(mark) ?? null;
  waiting.delete(mark);
  return probe;
}

export function runInGateProbe<T>(probe: GateProbe, fn: () => T): T {
  return storage.run(probe, fn);
}

/** Called where a gate passes or a write is about to run: inside a live
 *  probe, records that the route got through and stops it right there. */
export function stopAtGate(): void {
  const probe = storage.getStore();
  if (!probe || probe.done) return;
  probe.passed = true;
  probe.done = true;
  throw new GateProbeStop();
}

/** The route answered without passing a gate or writing (a refusal, a 404). */
export function settleGateProbe(probe: GateProbe): void {
  probe.done = true;
}
