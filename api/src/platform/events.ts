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

/** Subscribe a module's handler to an event name. */
export function on(eventName: string, module: string, handler: EventHandler): void {
  const list = subs.get(eventName) ?? [];
  list.push({ handler: handler as EventHandler, module });
  subs.set(eventName, list);
}

/** Emit an event. Returns a Promise that resolves once the wire
 *  engine has finished firing any user-configured bindings. Direct
 *  subscribers registered via on() still run fire-and-forget on the
 *  next microtask tick (slow side-effects shouldn't block responses).
 *
 *  THE RULE: `await emit(...)` when anything after you depends on what
 *  the wire does; `void emit(...)` is for notifications. "Depends"
 *  includes a response the client will act on by re-reading (a route
 *  that answers "restocked" and a page that refetches the stock), a
 *  later step that assumes the move landed (a cancel that reverses a
 *  commit), and a second emit whose wire touches the same ledger. A
 *  wire that MOVES stock or a count is never a notification. emit never
 *  rejects, so awaiting costs latency and nothing else; a `void` on one
 *  of these let a build's reversal overtake its commit into the stock
 *  floor and leave phantom output credit (#2826), and let a shopping
 *  row answer before the restock it promised had landed. */
export async function emit<T>(eventName: string, payload: T): Promise<void> {
  // 1. Fan out to direct subscribers — fire-and-forget on next tick.
  const list = subs.get(eventName);
  if (list && list.length > 0) {
    void Promise.resolve().then(async () => {
      for (const s of list) {
        try {
          await s.handler(payload);
        } catch (err) {
          console.error(
            `[events] handler ${s.module} failed for ${eventName}:`,
            err,
          );
        }
      }
    });
  }
  // 2. Fire user-configured wires inline so awaiting callers get
  // sync read-after-write semantics. Wire failures are swallowed
  // (matched to the contract: emit never rejects).
  const p = payload as { orgId?: unknown };
  if (p && typeof p.orgId === "string") {
    try {
      await fireEvent(eventName, p.orgId, payload as Record<string, unknown>);
    } catch (err) {
      console.error(`[events] wire engine failed for ${eventName}:`, err);
    }
  }
}
