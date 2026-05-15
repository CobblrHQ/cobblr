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

/** Emit an event. Fire-and-forget — handlers run on the next
 *  microtask tick so the emitter isn't blocked by slow subscribers.
 *  Errors in handlers are logged but never propagate. Wires fire
 *  alongside direct subscribers. */
export function emit<T>(eventName: string, payload: T): void {
  // 1. Fan out to direct subscribers
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
  // 2. Fire user-configured wires (decoupled from direct subs)
  const p = payload as { orgId?: unknown };
  if (p && typeof p.orgId === "string") {
    const orgId = p.orgId;
    void Promise.resolve().then(async () => {
      try {
        await fireEvent(eventName, orgId, payload as Record<string, unknown>);
      } catch (err) {
        console.error(`[events] wire engine failed for ${eventName}:`, err);
      }
    });
  }
}

/** For tests + diagnostics. */
export function listSubscriptionsFor(eventName: string): string[] {
  return (subs.get(eventName) ?? []).map((s) => s.module);
}
