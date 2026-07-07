// Which Cobblr (connection, device) pairs an external detector OWNS — i.e. a
// detector marked `owns` handles that printer's detection + camera, so Cobblr
// stands down its OWN failure watch, assignment, and camera pull for it (the
// single-owner rule; avoids two systems pulling the same chamber cam). Derived
// live from every enabled detector's config: `owns` + the keys of `camera_map`
// ("<connId>:<deviceId>", the same shape the fleet + assign worker key on).

import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";

/** Pure: collect the owned "<connId>:<deviceId>" refs from detector config rows. */
export function collectOwnedRefs(rows: Array<{ config: unknown }>): Set<string> {
  const refs = new Set<string>();
  for (const row of rows) {
    const cfg = (row.config ?? {}) as { owns?: boolean; camera_map?: Record<string, string> };
    if (!cfg.owns || !cfg.camera_map) continue;
    for (const ref of Object.keys(cfg.camera_map)) refs.add(ref);
  }
  return refs;
}

/** The owned device refs for the workspace (empty when no detector owns anything). */
export async function ownedDeviceRefs(db: Kysely<DigifabDB>): Promise<Set<string>> {
  const rows = await db.selectFrom("digifab_detectors").select("config").where("enabled", "=", true).execute();
  return collectOwnedRefs(rows);
}
