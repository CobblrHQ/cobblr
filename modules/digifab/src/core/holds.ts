// A machine can be held by something running it (a cell's job holds its CNC
// and its arm): while it is, nothing else in Digital Fabrication sends it
// work. A family registers what holds its machines; the core asks here before
// it sends a job or starts a file, and pause and stop never ask.
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";

export type MachineHold = (db: Kysely<DigifabDB>, connectionId: string, deviceId: string | null) => Promise<string | null>;
const holds: MachineHold[] = [];

export function registerMachineHold(hold: MachineHold): void { if (!holds.includes(hold)) holds.push(hold); }

/** Why this machine takes no work now, or null. */
export async function machineHoldRefusal(db: Kysely<DigifabDB>, connectionId: string, deviceId: string | null): Promise<string | null> {
  for (const hold of holds) { const why = await hold(db, connectionId, deviceId); if (why) return why; }
  return null;
}
