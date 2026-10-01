// A wire on "a record is created / updated / deleted" (trigger on-create,
// on-update, on-delete) runs on its kind's own lifecycle event.
//
// The composer offered these three as its first choice, bundles and the AI
// bundle builder wrote them, and the server stored them, but the engine only
// ever selected trigger_type "event": every one was dead from the day it was
// saved. There is no kernel-wide record write path to hook, so the event is
// the module's own, named by the convention every module follows,
// `<module>.<noun>.<verb>`, and a kind that declares no such event cannot
// carry the trigger: the save is refused rather than stored dead.
//
// One place for the mapping, so the engine (wires.ts) and the save check
// (routes/platform.ts) cannot disagree about which event a trigger means.

import { listEntries } from "../modules/registry.js";

export type LifecycleTrigger = "on-create" | "on-update" | "on-delete";
export const LIFECYCLE_TRIGGERS: readonly LifecycleTrigger[] = ["on-create", "on-update", "on-delete"];

/** The verbs modules use for each moment ("added" and "removed" are the
 *  older spellings a few modules still emit). */
const VERBS: Record<LifecycleTrigger, readonly string[]> = {
  "on-create": ["created", "added"],
  "on-update": ["updated"],
  "on-delete": ["deleted", "removed"],
};

export function isLifecycleTrigger(t: string): t is LifecycleTrigger {
  return (LIFECYCLE_TRIGGERS as readonly string[]).includes(t);
}

/** Which trigger, on which kind, an event name is: "inventory.part.created"
 *  is on-create of inventory:part. Null for any other event. */
export function lifecycleOf(eventName: string): { baseKind: string; trigger: LifecycleTrigger } | null {
  const m = /^([a-z0-9][a-z0-9-]*)\.([a-z0-9_]+)\.([a-z]+)$/.exec(eventName);
  if (!m) return null;
  const verb = m[3]!;
  for (const t of LIFECYCLE_TRIGGERS) if (VERBS[t].includes(verb)) return { baseKind: `${m[1]}:${m[2]}`, trigger: t };
  return null;
}

/** Every event a module declares it emits. */
function declared(): Set<string> {
  const out = new Set<string>();
  for (const e of listEntries()) for (const ev of e.manifest.exposes?.events ?? []) out.add(ev);
  return out;
}

/** The event a lifecycle trigger on this kind runs on, when its module
 *  declares one; null when records of this kind say nothing at that moment. */
export function lifecycleEventFor(baseKind: string, trigger: LifecycleTrigger): string | null {
  const [mod, noun] = baseKind.split(":");
  if (!mod || !noun) return null;
  const events = declared();
  for (const verb of VERBS[trigger]) {
    const name = `${mod}.${noun}.${verb}`;
    if (events.has(name)) return name;
  }
  return null;
}

/** Base kinds whose delete event names the collection (instance) the record
 *  was in. Only for these can a delete wire on one collection tell its own
 *  records from another's: the record is gone, so it cannot be looked up. */
export const DELETE_NAMES_ITS_INSTANCE: ReadonlySet<string> = new Set(["records:record"]);

/** Why a lifecycle wire on this kind could never run, in a person's words;
 *  null when it can. */
export function lifecycleRefusal(baseKind: string, trigger: LifecycleTrigger, isInstance: boolean): string | null {
  if (!lifecycleEventFor(baseKind, trigger)) {
    const moment = trigger === "on-create" ? "created" : trigger === "on-update" ? "changed" : "deleted";
    return `Records of this kind say nothing when one is ${moment}, so this wire would never run. Choose "Something happens" and one of its events instead.`;
  }
  if (trigger === "on-delete" && isInstance && !DELETE_NAMES_ITS_INSTANCE.has(baseKind)) {
    return `A record deleted here cannot be told apart from one deleted in another collection of the same kind, so this wire would run for both. Put it on the kind itself instead.`;
  }
  return null;
}
