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
}

const families: DigifabFamily[] = [];

export function registerFamilies(list: readonly DigifabFamily[]): void {
  for (const f of list) if (!families.some((x) => x.part === f.part)) { families.push(f); f.register(); }
}

/** The family whose machines report this station kind, if any. */
export function familyOfStationKind(kind: string | null | undefined): DigifabFamily | null {
  return (kind && families.find((f) => f.stationKinds.includes(kind))) || null;
}

export function familyStationKinds(): ReadonlySet<string> {
  return new Set(families.flatMap((f) => f.stationKinds));
}
