// Read/write the live Bambu telemetry cache (digifab_bambu_status). The pump
// writes the latest MQTT report per (connection, serial); the fleet reads the
// fresh rows and overlays temps/progress/state onto the device card. Mirrors
// snapshot-store: tenant DB, overwrite-on-push, freshness-windowed read.

import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import type { DeviceTemps } from "./drivers/types.js";

// Bambu pushes a heartbeat well inside a minute; 90s means a printer that's
// genuinely gone (or a dropped pump) falls back to HTTP within ~1.5 min.
const TTL_MS = 90_000;

export interface BambuLiveStatus {
  state: string | null;
  stage: string | null;
  temps: DeviceTemps;
  progress: number | null;
  remaining_min: number | null;
  layer_num: number | null;
  total_layers: number | null;
}

/** Upsert the latest telemetry for one printer. */
export async function putBambuStatus(db: Kysely<DigifabDB>, connId: string, serial: string, s: BambuLiveStatus): Promise<void> {
  const row = {
    connection_id: connId,
    serial,
    state: s.state,
    stage: s.stage,
    nozzle_actual: s.temps.nozzle?.actual ?? null,
    nozzle_target: s.temps.nozzle?.target ?? null,
    bed_actual: s.temps.bed?.actual ?? null,
    bed_target: s.temps.bed?.target ?? null,
    chamber_actual: s.temps.chamber?.actual ?? null,
    chamber_target: s.temps.chamber?.target ?? null,
    progress: s.progress,
    remaining_min: s.remaining_min,
    layer_num: s.layer_num,
    total_layers: s.total_layers,
    updated_at: new Date(),
  };
  await db
    .insertInto("digifab_bambu_status")
    .values(row)
    .onConflict((oc) => oc.columns(["connection_id", "serial"]).doUpdateSet(row))
    .execute();
}

/** Fresh telemetry for every printer on a connection, keyed by serial. Stale
 *  rows are dropped (→ the fleet uses the HTTP status instead). */
export async function getBambuStatusMap(db: Kysely<DigifabDB>, connId: string): Promise<Map<string, BambuLiveStatus>> {
  const rows = await db
    .selectFrom("digifab_bambu_status")
    .selectAll()
    .where("connection_id", "=", connId)
    .where("updated_at", ">", new Date(Date.now() - TTL_MS))
    .execute();
  const map = new Map<string, BambuLiveStatus>();
  for (const r of rows) {
    const temps: DeviceTemps = {
      nozzle: r.nozzle_actual != null ? { actual: r.nozzle_actual, target: r.nozzle_target ?? undefined } : null,
      bed: r.bed_actual != null ? { actual: r.bed_actual, target: r.bed_target ?? undefined } : null,
      chamber: r.chamber_actual != null ? { actual: r.chamber_actual, target: r.chamber_target ?? undefined } : null,
    };
    map.set(r.serial, {
      state: r.state,
      stage: r.stage,
      temps,
      progress: r.progress,
      remaining_min: r.remaining_min,
      layer_num: r.layer_num,
      total_layers: r.total_layers,
    });
  }
  return map;
}
