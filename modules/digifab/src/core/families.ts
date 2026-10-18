// The family seam (docs/modules/digifab-families.md). Digital Fabrication is
// a shared core (drivers, jobs and runs, stations and approvals, makes, the
// library, the floor) and families of machines on it: robot arms first, then
// lasers, printers, CNC and the rest as they move out of the flat folder. A
// family lives in src/families/<family>/ and declares itself to the core here:
// its module part, the station kinds its machines report, its routes, and the
// handlers and boot work it registers. The core never imports a family
// (lint:core-imports-no-family); a family imports only the core
// (lint:family-imports-only-core). src/families/index.ts and manifests.ts
// are the one place the module gathers them.
import type { Router } from "express";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { ReviewRequired } from "../drivers/job-review.js";

export interface DigifabFamily {
  /** The module part this family is (manifest `parts`): off in a workspace,
   *  the kernel hides its actions, panels, tools and routes there. */
  part: string;
  /** The station kinds its machines report (`station_kind` on a device). */
  stationKinds: readonly string[];
  /** Its routes, each mounted at its path under the module's API. */
  routes: ReadonlyArray<{ path: string; router: Router }>;
  /** Action handlers, resolvers and panel presence, once when the api loads. */
  register(): void;
  /** Sweeps and heal passes, once at boot. */
  onBoot?(): Promise<void> | void;
  /** Its machines start at a station though they report no station kind: a
   *  kiln is known by the telemetry its device reports. */
  startsAtStation?(raw: Record<string, unknown> | null | undefined): boolean;
  /** The operations it answers on digifab:station-run, `<prefix>_<op>`. */
  stationRun?: {
    prefix: string;
    run(db: Kysely<DigifabDB>, orgId: string, userId: string, operation: string, id: string, fields: unknown): Promise<unknown>;
  };
  /** Before the outcome of a job it runs is recorded: throws until the
   *  family's own record of the job is complete. */
  checkJobOutcome?(db: Kysely<DigifabDB>, jobId: string, outcome: string): Promise<void>;
}

const families: DigifabFamily[] = [];

export function registerFamilies(list: readonly DigifabFamily[], opts: { handlers?: boolean } = {}): void {
  for (const f of list) if (!families.some((x) => x.part === f.part)) { families.push(f); if (opts.handlers !== false) f.register(); }
}

/** The family whose machines report this station kind, if any. */
export function familyOfStationKind(kind: string | null | undefined): DigifabFamily | null {
  return (kind && families.find((f) => f.stationKinds.includes(kind))) || null;
}

export function familyStationKinds(): ReadonlySet<string> {
  return new Set(families.flatMap((f) => f.stationKinds));
}

/** The family whose machines start at a station by what this device reports. */
export function familyStartingAtStation(raw: Record<string, unknown> | null | undefined): DigifabFamily | null {
  return families.find((f) => f.startsAtStation?.(raw)) ?? null;
}

/** The family that answers this station-run operation, and the operation's
 *  own name within it. */
export function familyStationRun(operation: string): { family: DigifabFamily; operation: string } | null {
  for (const f of families) {
    const p = f.stationRun?.prefix;
    if (p && operation.startsWith(`${p}_`)) return { family: f, operation: operation.slice(p.length + 1) };
  }
  return null;
}

/** The check of the family that runs this job, before its outcome is
 *  recorded. Fails closed: a job a family runs is never judged without it. */
export async function checkFamilyJobOutcome(part: string, db: Kysely<DigifabDB>, jobId: string, outcome: string): Promise<void> {
  const family = families.find((f) => f.part === part);
  if (!family?.checkJobOutcome) throw new ReviewRequired("Record this job's outcome at its machine's station.");
  await family.checkJobOutcome(db, jobId, outcome);
}
