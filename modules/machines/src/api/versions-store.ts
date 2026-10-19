// Where a machine's versions come from and go to: a driver's reading (the
// digifab event), a person typing one (the record's PATCH), the fleet read and
// the cohort targets. The judging is ../versions.ts.

import { platform, placeLine, type PlacePathStep } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { MachinesDB, VersionSource } from "../db.js";
import { GONE_STATES } from "./resolvers.js";
import { parentsOf, unitsOf } from "./units.js";
import { cohortOf, summarizeFleet, VERSION_FIELDS, type FleetMachine, type VersionField } from "../versions.js";

const KIND = "machines:machine";
const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

/** A PATCH or create that types a version: the columns that say a person said
 *  so, now. Clearing one clears where it came from too. */
export function typedStamp(data: Record<string, unknown>, now = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of VERSION_FIELDS) {
    const key = `${f}_version`;
    if (!(key in data)) continue;
    const v = clean(data[key]);
    out[key] = v;
    out[`${f}_source`] = v ? ("typed" satisfies VersionSource) : null;
    out[`${f}_seen_at`] = v ? now : null;
  }
  return out;
}

const SOURCE_WORDS: Record<VersionSource, string> = { reported: "reported by the machine", typed: "typed" };

/** The History line's words for one version that changed. */
export function versionChangeLine(field: VersionField, from: string | null, to: string | null, source: VersionSource): string {
  const what = field === "firmware" ? "Firmware" : "Software";
  if (!to) return `${what} ${from} cleared`;
  return from ? `${what} ${from} → ${to} (${SOURCE_WORDS[source]})` : `${what} ${to} (${SOURCE_WORDS[source]})`;
}

export type ReportedVersions = { firmware?: string | null; software?: string | null; controller?: string | null; seen_at?: string | null };

/** A driver's reading lands on the machine it is linked to: each version it
 *  reported is believed as of now, a change is a line in the machine's
 *  History, and a value the driver did not report is left as it was (a typed
 *  firmware stays when the driver only knows its software). */
export async function applyReportedVersions(orgId: string, machineId: string, r: ReportedVersions): Promise<{ changed: string[] } | null> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
  const before = await db.selectFrom("machines_machines").selectAll().where("id", "=", machineId).executeTakeFirst();
  if (!before) return null;
  const seen = r.seen_at && Number.isFinite(Date.parse(r.seen_at)) ? new Date(r.seen_at) : new Date();
  const set: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const f of VERSION_FIELDS) {
    const v = clean(r[f]);
    if (!v) continue;
    // A late reading cannot make a machine look older or more silent than one already recorded.
    const had = before[`${f}_seen_at`];
    if (had && new Date(had).getTime() > seen.getTime()) continue;
    set[`${f}_version`] = v;
    set[`${f}_source`] = "reported";
    set[`${f}_seen_at`] = seen;
    if (v !== before[`${f}_version`]) changed.push(versionChangeLine(f, before[`${f}_version`], v, "reported"));
  }
  const controller = clean(r.controller);
  if (controller && !before.controller) set.controller = controller;
  if (!Object.keys(set).length) return { changed };
  await db.updateTable("machines_machines").set(set as never)
    .where("id", "=", machineId)
    .execute();
  if (changed.length) {
    const diff: Record<string, unknown> = {};
    const prior: Record<string, unknown> = {};
    for (const f of VERSION_FIELDS) if (`${f}_version` in set && set[`${f}_version`] !== before[`${f}_version`]) {
      diff[`${f}_version`] = set[`${f}_version`];
      prior[`${f}_version`] = before[`${f}_version`];
    }
    await platform().activity.log({ orgId, userId: null, action: "versions_reported", ref: { module: "machines", entityType: "machine", entityId: machineId }, diff, before: prior });
  }
  return { changed };
}

/** The machines one collection counts, as the versions view judges them. A
 *  machine that has left is not in the fleet; a record standing for several
 *  counts the ones not named (its named units are records of their own). */
async function fleetMachines(db: Kysely<MachinesDB>, orgId: string, instance: string): Promise<Array<FleetMachine & { where: string | null; path: PlacePathStep[] }>> {
  const rows = await db.selectFrom("machines_machines").selectAll()
    .where("instance", "=", instance)
    .where(sql<boolean>`lower(coalesce(state, '')) not in (${sql.join([...GONE_STATES])})`)
    .execute();
  const ids = rows.map((r) => r.id);
  const parents = await parentsOf(orgId, ids);
  const named = await unitsOf(orgId, ids.filter((id) => !parents.has(id)));
  const paths = await platform().placement.pathsOf({ orgId, containees: ids.map((id) => ({ kind: KIND, id })) });
  return rows.map((r) => {
    const path = paths.get(`${KIND}:${r.id}`) ?? [];
    const count = parents.has(r.id) ? 1 : Math.max(0, Number(r.quantity ?? 1) - (named.get(r.id)?.length ?? 0));
    return { ...r, count, where: path.length ? placeLine(path) : null, path };
  });
}

export type FleetQuery = { location_id?: string | null };

/** The versions view: cohort by cohort, against each one's target. */
export async function readFleet(db: Kysely<MachinesDB>, orgId: string, instance: string, q: FleetQuery = {}, now = new Date()) {
  const all = await fleetMachines(db, orgId, instance);
  const inside = q.location_id ? all.filter((m) => m.location_id === q.location_id || m.path.some((p) => p.id === q.location_id)) : all;
  const targets = await db.selectFrom("machines_version_targets").selectAll().where("instance", "=", instance).execute();
  const cohorts = summarizeFleet(inside, targets, now);
  const where = new Map(inside.map((m) => [m.id, m.where]));
  const totals = cohorts.reduce((t, c) => ({ machines: t.machines + c.machines, current: t.current + c.current, behind: t.behind + c.behind, unknown: t.unknown + c.unknown, down_for_repair: t.down_for_repair + c.down_for_repair }), { machines: 0, current: 0, behind: 0, unknown: 0, down_for_repair: 0 });
  // Places a person can filter by: everything the machines here are in, at any depth.
  const places = new Map<string, string>();
  for (const m of all) for (const p of m.path) places.set(p.id, p.name);
  return {
    as_of: now.toISOString(),
    location_id: q.location_id ?? null,
    totals,
    cohorts: cohorts.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, where: where.get(i.id) ?? null })) })),
    places: [...places].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The cohort names a collection has now, as the view shows them. */
export async function cohortsIn(db: Kysely<MachinesDB>, orgId: string, instance: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const m of await fleetMachines(db, orgId, instance)) {
    const c = cohortOf(m);
    out.set(c.key, c.label);
  }
  return out;
}
