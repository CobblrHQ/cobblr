// ONE vocabulary for a fleet device's live status — shared by the digifab
// floor (bucket chips/filters) and the machines registry (live chip on a
// linked machine's card). Grew from two divergent copies (DigifabPage's
// deviceBucket vs MachinesPage's digifabStatusChip) — see
// docs/design-decisions/machines-digifab-unification.md §3.

import type { DigifabFleet, DigifabFleetDevice } from "./api";

export type FleetBucket = "working" | "needs" | "idle" | "off";

/** Which operator bucket a device falls in — the Bambu-style "what do I do"
 *  grouping (see docs/design-decisions/digifab-farm-view-anatomy.md). */
export function deviceBucket(d: DigifabFleetDevice): FleetBucket {
  // Out of contact: what it last said may be long over, so someone looks.
  if (d.needs_attention || d.out_of_contact || d.klass === "error" || d.klass === "complete") return "needs";
  // A device is WORKING when Cobblr has a live job on it, even if the manager's
  // state string reads "operational" mid-print (some managers do).
  if (d.klass === "printing" || d.klass === "paused" || (d.active_job && ["printing", "paused", "sent"].includes(d.active_job.status))) return "working";
  if (d.klass === "offline") return "off";
  return "idle";
}

/** Live status chip for a linked machine — label + dot class, derived from the
 *  fleet's view of the device. Falls back to "linked" before the fleet has
 *  reported (or for a device the manager doesn't surface live). */
export function fleetStatusChip(dev: DigifabFleetDevice | undefined): { label: string; dot: string } {
  if (!dev) return { label: "linked", dot: "bg-emerald-500" };
  if (dev.out_of_contact) return { label: "out of contact", dot: "bg-amber-500" };
  if (dev.needs_attention) return { label: "needs clearing", dot: "bg-amber-500" };
  const state = dev.active_job?.status === "printing" ? "running" : dev.active_job?.status === "paused" ? "paused" : dev.state.toLowerCase();
  const laser = !!dev.laser_backend || dev.id === "lightburn" || !!dev.lightburn_readiness;
  if (state === "paused") return { label: "paused", dot: "bg-amber-500" };
  if (state === "printing" || state === "running") {
    const p = dev.active_job?.progress;
    const action = laser ? "running" : "printing";
    return { label: typeof p === "number" ? `${action} ${Math.round(p * 100)}%` : action, dot: "bg-cobble-500" };
  }
  switch (state) {
    case "idle": return { label: "idle", dot: "bg-emerald-500" };
    case "completed": return { label: "done", dot: "bg-emerald-500" };
    case "failed":
    case "error": return { label: "error", dot: "bg-ember-500" };
    case "offline": return { label: "offline", dot: "bg-slate-400 dark:bg-slate-500" };
    default: return { label: "connected", dot: "bg-emerald-500" };
  }
}

/** "Out of contact since 3:41 PM" (a date first when not today) for a device
 *  whose manager stopped answering; null while it answers (#7902). */
export function outOfContactLine(d: Pick<DigifabFleetDevice, "out_of_contact">, now = new Date()): string | null {
  if (!d.out_of_contact) return null;
  const at = new Date(d.out_of_contact.last_contact);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = at.toDateString() === now.toDateString();
  return `Out of contact since ${today ? time : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`}`;
}

/** machine_id → its linked fleet device (with the owning connection id), so
 *  registry surfaces can decorate machine rows with live status in one pass. */
export function indexFleetByMachine(fleet: DigifabFleet | undefined): Map<string, { dev: DigifabFleetDevice; connId: string }> {
  const byMachine = new Map<string, { dev: DigifabFleetDevice; connId: string }>();
  for (const c of fleet?.connections ?? []) {
    for (const d of c.devices) {
      if (d.linked_machine_id) byMachine.set(d.linked_machine_id, { dev: d, connId: c.connection_id });
    }
  }
  return byMachine;
}
