// In-process event bus + wire-engine bridge.
//
// emit() fires both direct subscribers (registered via on()) AND
// user-configured wires (entity_action_bindings) for the event. The
// two routes coexist: subscribers are for tight module-internal
// reactions; wires are for user-configurable connections between
// modules.
//
// By convention all event payloads include an orgId field. We pull
// that out so the wire engine knows which tenant to scope to.

import { fireEvent } from "./wires.js";

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

interface Subscription {
  handler: EventHandler;
  module: string; // for diagnostics
}

const subs = new Map<string, Subscription[]>();

/** TEST-ONLY, set through routes/test-support.ts (mounted under the org-pool
 *  flag, never in prod): stretch the gap between one workspace's emit of one
 *  event and its subscribers, so a race that is intermittent under runner
 *  load is certain in a test. Scoped to the event AND the org so the other
 *  test files sharing this api process never feel it. */
let subscriberDelay: { event: string; orgId: string; ms: number } | null = null;
export function setSubscriberDelayForTests(d: { event: string; orgId: string; ms: number } | null): void {
  subscriberDelay = d && d.ms > 0 ? d : null;
}

/** Subscribe a module's handler to an event name. */
export function on(eventName: string, module: string, handler: EventHandler): void {
  const list = subs.get(eventName) ?? [];
  list.push({ handler: handler as EventHandler, module });
  subs.set(eventName, list);
}

/** Emit an event. Resolves once every direct subscriber registered via
 *  on() has run, in order, and then the wire engine has finished firing
 *  any user-configured bindings. Subscribers run inline for the same
 *  reason wires do: a caller that awaits gets read-after-write for BOTH.
 *  Until #2839 subscribers ran detached on the next microtask, so an
 *  awaited emit promised something false for them: a scan attach answered
 *  before core-cadence had recorded the purchase, and an undo pressed at
 *  once found nothing to void while the purchase landed a tick later and
 *  survived. A subscriber that does slow work (a carrier re-check, a PDF
 *  render) schedules that work itself and returns; the bus does not
 *  decide that for it.
 *
 *  THE RULE: `await emit(...)` when anything after you depends on what a
 *  subscriber or a wire does; `void emit(...)` is for notifications.
 *  "Depends" includes a response the client will act on by re-reading (a
 *  route that answers "restocked" and a page that refetches the stock), a
 *  later step that assumes the move landed (a cancel that reverses a
 *  commit, an undo that voids a purchase), and a second emit whose wire
 *  touches the same ledger. A handler that MOVES stock, a count or a
 *  ledger row is never a notification. emit never rejects, so awaiting
 *  costs latency and nothing else; a `void` on one of these let a build's
 *  reversal overtake its commit into the stock floor and leave phantom
 *  output credit (#2826), and let a shopping row answer before the
 *  restock it promised had landed. */
export async function emit<T>(eventName: string, payload: T): Promise<void> {
  // 1. Direct subscribers, inline and in order. A failure is logged and
  // the next subscriber still runs (matched to the contract: emit never
  // rejects). A void caller is not made to wait; it never was.
  const list = subs.get(eventName);
  if (list && list.length > 0) {
    const d = subscriberDelay;
    if (d && d.event === eventName && (payload as { orgId?: unknown } | null)?.orgId === d.orgId) {
      await new Promise<void>((r) => setTimeout(r, d.ms));
    }
    for (const s of list) {
      try {
        await s.handler(payload);
      } catch (err) {
        console.error(`[events] handler ${s.module} failed for ${eventName}:`, err);
      }
    }
  }
  // 2. User-configured wires, inline, so awaiting callers get
  // read-after-write for those too. Wire failures are swallowed.
  const p = payload as { orgId?: unknown };
  if (p && typeof p.orgId === "string") {
    try {
      await fireEvent(eventName, p.orgId, payload as Record<string, unknown>);
    } catch (err) {
      console.error(`[events] wire engine failed for ${eventName}:`, err);
    }
  }
}
