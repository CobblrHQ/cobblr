import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { runSerialised } from "./exclusive.js";
import type { ScanStation, StationMode, StationRef, StationResult, StationSession } from "@cobblr/platform-contract/scan-station";

async function db() { return (await import("../db/meta.js")).meta; }

export const stationStore = {
  async create(orgId: string, userId: string, name: string, mode: StationMode): Promise<ScanStation> {
    const state: ScanStation = { id: randomUUID(), name, mode, context: null, last_thing: null, session_id: null, last_at: null, command: null, last_tag: null };
    await sql`insert into scan_stations (id, org_id, user_id, state) values (${state.id}, ${orgId}, ${userId}, ${JSON.stringify(state)}::jsonb)`.execute(await db());
    return state;
  },
  async list(orgId: string, userId: string): Promise<ScanStation[]> {
    return (await sql<{ state: ScanStation }>`select state from scan_stations where org_id = ${orgId} and user_id = ${userId} order by updated_at desc`.execute(await db())).rows.map((r) => r.state);
  },
  async locked<T>(orgId: string, userId: string, deviceId: string, work: (device: ScanStation) => Promise<T>): Promise<T> {
    return runSerialised(`scan-station:${deviceId}`, async () => {
      const row = (await sql<{ state: ScanStation }>`select state from scan_stations where id = ${deviceId} and org_id = ${orgId} and user_id = ${userId}`.execute(await db())).rows[0];
      if (!row) throw Object.assign(new Error("That station is not yours in this workspace."), { status: 404 });
      return work(row.state);
    });
  },
  async saveDevice(device: ScanStation): Promise<void> {
    await sql`update scan_stations set state = ${JSON.stringify(device)}::jsonb, updated_at = now() where id = ${device.id}`.execute(await db());
  },
  async session(deviceId: string, id: string): Promise<StationSession> {
    const row = (await sql<{ state: StationSession }>`select state from scan_station_sessions where id = ${id} and device_id = ${deviceId}`.execute(await db())).rows[0];
    if (!row) throw Object.assign(new Error("That session is not from this station."), { status: 404 });
    return row.state;
  },
  async sessions(deviceId: string, before?: string): Promise<StationSession[]> {
    return (await sql<{ state: StationSession }>`select state from scan_station_sessions where device_id = ${deviceId}
      ${before ? sql`and started_at < ${before}::timestamptz` : sql``} order by started_at desc limit 51`.execute(await db())).rows.map((r) => r.state);
  },
  async saveSession(session: StationSession): Promise<void> {
    await sql`insert into scan_station_sessions (id, device_id, state, started_at) values (${session.id}, ${session.device_id}, ${JSON.stringify(session)}::jsonb, ${session.started_at}::timestamptz)
      on conflict (id) do update set state = excluded.state`.execute(await db());
  },
  async request(deviceId: string, requestId: string): Promise<{ code: string; result: StationResult } | null> {
    return (await sql<{ code: string; result: StationResult }>`select code, result from scan_station_requests where device_id = ${deviceId} and request_id = ${requestId}`.execute(await db())).rows[0] ?? null;
  },
  async journal(deviceId: string, requestId: string): Promise<StationSession | null> {
    return (await sql<{ state: StationSession }>`select state from scan_station_sessions where device_id = ${deviceId}
      and state->'actions' @> ${JSON.stringify([{ request_id: requestId }])}::jsonb limit 1`.execute(await db())).rows[0]?.state ?? null;
  },
  async saveRequest(deviceId: string, requestId: string, code: string, result: StationResult): Promise<void> {
    await sql`insert into scan_station_requests (device_id, request_id, code, result) values (${deviceId}, ${requestId}, ${code}, ${JSON.stringify(result)}::jsonb) on conflict do nothing`.execute(await db());
  },
  async alias(orgId: string, uid: string): Promise<StationRef | null> {
    return (await sql<{ target: StationRef }>`select target from scan_tag_aliases where org_id = ${orgId} and uid = ${uid}`.execute(await db())).rows[0]?.target ?? null;
  },
  async link(orgId: string, uid: string, target: StationRef): Promise<void> {
    const row = (await sql<{ target: StationRef }>`insert into scan_tag_aliases (org_id, uid, target) values (${orgId}, ${uid}, ${JSON.stringify(target)}::jsonb)
      on conflict (org_id, uid) do update set target = scan_tag_aliases.target returning target`.execute(await db())).rows[0];
    if (row?.target.kind !== target.kind || row?.target.id !== target.id) throw Object.assign(new Error("That tag is already linked to another record. Use a different tag."), { status: 409 });
  },
  async undelivered(deviceId: string): Promise<StationSession[]> {
    return (await sql<{ state: StationSession }>`select state from scan_station_sessions where device_id = ${deviceId} and state->>'ended_at' is not null and state->>'notified' = 'false'`.execute(await db())).rows.map((r) => r.state);
  },
  async candidates(orgIds: string[]): Promise<Array<{ id: string; org_id: string; user_id: string }>> {
    if (!orgIds.length) return [];
    return (await sql<{ id: string; org_id: string; user_id: string }>`select d.id, d.org_id, d.user_id from scan_stations d
      where d.org_id in (${sql.join(orgIds)}) and (d.state->>'session_id' is not null or exists
        (select 1 from scan_station_sessions s where s.device_id = d.id and s.state->>'ended_at' is not null and s.state->>'notified' = 'false'))`.execute(await db())).rows;
  },
};
