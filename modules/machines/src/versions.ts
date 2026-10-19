// What a machine runs, judged against what the shop wants its cohort on.
// Pure: the routes, the assistant's read and the tests all judge through here,
// so "current" means one thing everywhere.

import type { VersionSource } from "./db.js";

const DAY = 24 * 60 * 60 * 1000;

/** How long a reading is believed. A driver asks every hour, so a week of
 *  silence means the machine is off the network, not on the same version. A
 *  person's typed version is believed longer, but not forever. */
export const STALE_AFTER_MS: Record<VersionSource, number> = { reported: 7 * DAY, typed: 90 * DAY };

/** Machine states that mean it is out for repair, not working. */
export const DOWN_STATES: ReadonlySet<string> = new Set(["needs maintenance", "broken", "rebuilding"]);

export type VersionField = "firmware" | "software";
export const VERSION_FIELDS: readonly VersionField[] = ["firmware", "software"];
export type VersionStatus = "current" | "behind" | "unknown";

export type Reading = { version: string | null; source: VersionSource | null; seen_at: Date | string | null };

export type FleetMachine = {
  id: string;
  name: string;
  state: string | null;
  family: string | null;
  manufacturer: string | null;
  type: string | null;
  controller: string | null;
  location_id: string | null;
  serial_number: string | null;
  firmware_version: string | null;
  firmware_source: VersionSource | null;
  firmware_seen_at: Date | string | null;
  software_version: string | null;
  software_source: VersionSource | null;
  software_seen_at: Date | string | null;
  /** How many physical machines this record stands for (a group's unnamed ones). */
  count: number;
};

export type Target = { cohort: string; firmware_target: string | null; software_target: string | null; updated_at?: Date | string | null };

const clean = (s: string | null | undefined): string => (s ?? "").trim().replace(/\s+/g, " ");

/** The cohort a machine is judged with: what it is (its family, else its
 *  make and type) and what firmware family it runs. Two Prusa MK4s on
 *  PrusaLink are one cohort; a MK4 on Klipper is another. */
export function cohortOf(m: Pick<FleetMachine, "family" | "manufacturer" | "type" | "controller">): { key: string; label: string } {
  const what = clean(m.family) || [clean(m.manufacturer), clean(m.type)].filter(Boolean).join(" ") || "Unspecified";
  const label = clean(m.controller) ? `${what} · ${clean(m.controller)}` : what;
  return { key: label.toLowerCase(), label };
}

/** A reading worth judging: a version, a source, and seen recently enough for that source. */
export function freshReading(r: Reading, now: Date): string | null {
  const version = clean(r.version);
  if (!version || !r.source || !r.seen_at) return null;
  const seen = new Date(r.seen_at).getTime();
  if (!Number.isFinite(seen) || now.getTime() - seen > STALE_AFTER_MS[r.source]) return null;
  return version;
}

type Parsed = { core: number[]; pre: string | null; post: number };

function parse(v: string): Parsed | null {
  const m = /^v?(\d+(?:\.\d+)*)(.*)$/i.exec(clean(v));
  if (!m) return null;
  const core = m[1]!.split(".").map(Number);
  let rest = m[2]!.replace(/\+.*$/, "");
  // git describe: "v0.12.0-123-gabc1234" is 123 commits after v0.12.0.
  const described = /^-(\d+)-g[0-9a-f]+(?:-dirty)?$/i.exec(rest);
  if (described) return { core, pre: null, post: Number(described[1]) };
  rest = rest.replace(/^[-_. ]+/, "");
  return { core, pre: rest ? rest.toLowerCase() : null, post: 0 };
}

/** Negative when `a` is older than `b`, 0 when the same, positive when newer;
 *  null when the two cannot be ordered (two builds named differently). */
export function compareVersions(a: string, b: string): number | null {
  if (clean(a).toLowerCase().replace(/^v/, "") === clean(b).toLowerCase().replace(/^v/, "")) return 0;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return d;
  }
  if (x.pre !== y.pre) {
    if (x.pre === null) return 1;
    if (y.pre === null) return -1;
    return null;
  }
  return x.post - y.post;
}

/** One version against its target. Missing or stale is unknown, never current;
 *  a build that is older, or not the target and not orderable, is behind. */
export function versionStatus(r: Reading, target: string | null, now: Date): VersionStatus | null {
  if (!clean(target)) return null;
  const version = freshReading(r, now);
  if (!version) return "unknown";
  const c = compareVersions(version, target!);
  return c !== null && c >= 0 ? "current" : "behind";
}

const readingOf = (m: FleetMachine, f: VersionField): Reading => ({ version: m[`${f}_version`], source: m[`${f}_source`], seen_at: m[`${f}_seen_at`] });

/** A machine against its cohort's target: behind when any targeted version is
 *  behind, current only when every targeted version is, otherwise unknown.
 *  Null when the cohort has no target. */
export function machineStatus(m: FleetMachine, target: Target | undefined, now: Date): VersionStatus | null {
  if (!target) return null;
  const each = VERSION_FIELDS.map((f) => versionStatus(readingOf(m, f), target[`${f}_target`], now)).filter((s): s is VersionStatus => s !== null);
  if (!each.length) return null;
  if (each.includes("behind")) return "behind";
  return each.every((s) => s === "current") ? "current" : "unknown";
}

export type CohortSummary = {
  cohort: string;
  label: string;
  target: Target | null;
  machines: number;
  current: number;
  behind: number;
  unknown: number;
  down_for_repair: number;
  /** "15 of 20 current", or why it cannot say. */
  summary: string;
  versions: Array<{ field: VersionField; version: string; machines: number }>;
  items: Array<{
    id: string;
    name: string;
    state: string | null;
    serial_number: string | null;
    location_id: string | null;
    count: number;
    status: VersionStatus | null;
    down_for_repair: boolean;
    firmware: Reading & { fresh: boolean };
    software: Reading & { fresh: boolean };
  }>;
};

/** The fleet, cohort by cohort, counted in machines (a record standing for
 *  three identical printers is three). */
export function summarizeFleet(machines: FleetMachine[], targets: Target[], now: Date): CohortSummary[] {
  const byKey = new Map(targets.map((t) => [t.cohort.toLowerCase(), t]));
  const groups = new Map<string, CohortSummary>();
  for (const m of machines) {
    if (m.count <= 0) continue;
    const { key, label } = cohortOf(m);
    const target = byKey.get(key) ?? null;
    const g = groups.get(key) ?? { cohort: key, label, target, machines: 0, current: 0, behind: 0, unknown: 0, down_for_repair: 0, summary: "", versions: [], items: [] };
    groups.set(key, g);
    const status = machineStatus(m, target ?? undefined, now);
    const down = DOWN_STATES.has(clean(m.state).toLowerCase());
    g.machines += m.count;
    if (status) g[status] += m.count;
    if (down) g.down_for_repair += m.count;
    for (const f of VERSION_FIELDS) {
      const v = freshReading(readingOf(m, f), now);
      if (!v) continue;
      const row = g.versions.find((x) => x.field === f && x.version === v);
      if (row) row.machines += m.count;
      else g.versions.push({ field: f, version: v, machines: m.count });
    }
    const reading = (f: VersionField) => ({ ...readingOf(m, f), fresh: freshReading(readingOf(m, f), now) !== null });
    g.items.push({ id: m.id, name: m.name, state: m.state, serial_number: m.serial_number, location_id: m.location_id, count: m.count, status, down_for_repair: down, firmware: reading("firmware"), software: reading("software") });
  }
  for (const g of groups.values()) {
    const targeted = g.target && (clean(g.target.firmware_target) || clean(g.target.software_target));
    g.summary = targeted ? `${g.current} of ${g.machines} current` : "no target set";
    g.versions.sort((a, b) => b.machines - a.machines || a.version.localeCompare(b.version));
    g.items.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...groups.values()].sort((a, b) => b.machines - a.machines || a.label.localeCompare(b.label));
}
