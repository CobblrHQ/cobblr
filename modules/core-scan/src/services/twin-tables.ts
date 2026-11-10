// The tables a row's same-name twins in the inbox say it is kept in
// (kept-route.ts, #4591): where one was filed, else where it is headed, by
// the one destination the card shows (a person's choice first). Pure over
// the rows; the reads are the caller's.
//
// The live route asks every twin there is when a thing is scanned, and the
// twins there are then were all scanned before it. Asking again later
// (the re-route pass, #9404) must ask the same twins, or a leader would
// follow its own follower: so with `before`, a twin scanned after the row
// counts only when it says something a person decided, a filed record or a
// chosen list.

import { filedIntoOf, storedDestinationOf, type ScanResolverTable } from "@cobblr/platform-contract/scan-triage";
import { filingDestination, type DestinationRow } from "./destination.js";
import type { KeptTable } from "./kept-route.js";

export type TwinRow = DestinationRow & { id: string; created_at?: string | Date | null };

/** The row a twin is compared against: when it was scanned. */
export interface ScannedAt {
  id: string;
  created_at?: string | Date | null;
}

const timeOf = (v: string | Date | null | undefined): number => (v ? new Date(v).getTime() : NaN);

/** Whether `a` was scanned before `b`; the id breaks a tie, so of two rows
 *  made in one batch exactly one leads. Unknown times lead nothing. */
export function scannedBefore(a: ScannedAt, b: ScannedAt): boolean {
  const x = timeOf(a.created_at);
  const y = timeOf(b.created_at);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return x < y || (x === y && a.id < b.id);
}

export function twinTablesOf(rows: readonly TwinRow[], tables: readonly ScanResolverTable[], before?: ScannedAt): KeptTable[] {
  const out: KeptTable[] = [];
  for (const r of rows) {
    const filed = filedIntoOf(r.suggested_metadata);
    if (filed) {
      out.push({ module: filed.module, instance: filed.instance, kind: filed.kind });
      continue;
    }
    if (before && storedDestinationOf(r.suggested_metadata)?.by !== "person" && !scannedBefore(r, before)) continue;
    const d = filingDestination(r, tables);
    if (d?.module) out.push({ module: d.module, instance: d.instance ?? null, kind: typeof d.kind === "string" ? d.kind : null });
  }
  return out;
}
