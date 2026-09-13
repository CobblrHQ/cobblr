// What a feature change moves, and what it must leave alone.
//
// Turning a bundle's optional feature on or off re-applies the bundle with a
// different resolved set: fields, wires and views move; the tables the bundle
// set up, and every record in them, do not. The dialog says "your entities
// stay", and on staging it was false: the change was composed on the client
// as an uninstall and an install, the uninstall tore the instances down, and
// two yarn records went with them (#2889).
//
// The route now does the change itself, on the upgrade path, and PROVES the
// promise instead of asserting it: it reads every involved instance (id, row
// count) before, applies, reads again, and reports the difference. The two
// pure functions here are that arithmetic, so the rule is pinned by a unit
// test and the route, the activity log and the response tell one story.
import { promisedInstances, type PromisedInstance } from "./install-postcondition.js";

export interface FeatureManifest {
  provides_instances?: Array<{ module?: string; instance_name?: string }>;
  features?: Array<{ key?: string; provides_instances?: Array<{ module?: string; instance_name?: string }> }>;
}

export interface FeatureChange {
  /** Requested and not on before. Unknown keys are dropped: the manifest decides what exists. */
  turned_on: string[];
  /** On before and not requested. */
  turned_off: string[];
  /** Every instance the bundle sets up under EITHER set, deduped: the ledger
   *  to read before and after, because these are the ones that must survive. */
  involved: PromisedInstance[];
  /** Instances nothing in the bundle promises any more: only the features
   *  being turned off set them up. A released instance with records stays;
   *  one with none may go, since there is nothing to lose. */
  released: PromisedInstance[];
}

export function featureChange(manifest: FeatureManifest, before: readonly string[], after: readonly string[]): FeatureChange {
  const declared = new Set((manifest.features ?? []).map((f) => f.key).filter((k): k is string => !!k));
  const was = new Set(before.filter((k) => declared.has(k)));
  const now = new Set(after.filter((k) => declared.has(k)));
  const promisedBefore = promisedInstances(manifest, [...was]);
  const promisedAfter = promisedInstances(manifest, [...now]);
  const stillPromised = new Set(promisedAfter.map((p) => p.instance_name));
  const involved: PromisedInstance[] = [];
  const seen = new Set<string>();
  for (const p of [...promisedBefore, ...promisedAfter]) {
    if (seen.has(p.instance_name)) continue;
    seen.add(p.instance_name);
    involved.push(p);
  }
  return {
    turned_on: [...now].filter((k) => !was.has(k)),
    turned_off: [...was].filter((k) => !now.has(k)),
    involved,
    // registry-filter-ok: two lists of a MANIFEST's promised instances, not the kind registry
    released: promisedBefore.filter((p) => !stillPromised.has(p.instance_name)),
  };
}

/** One instance as it stands: its row id (identity) and how many rows across
 *  its module's tables belong to it. `records` is null when the count could
 *  not be read, which is not zero. */
export interface InstanceLedgerRow {
  instance_name: string;
  module: string;
  id: string;
  records: number | null;
}

export interface LedgerDiff {
  /** Present before and after under the same id, with no fewer records. */
  kept: InstanceLedgerRow[];
  /** Present before and after under a DIFFERENT id: the table was re-made,
   *  and everything keyed to the old id (links, views, bookmarks) points at
   *  nothing. This is the bug, and the route logs it as one. */
  re_created: Array<{ instance_name: string; before_id: string; after_id: string }>;
  /** Present before and after, same id, fewer records than before. */
  lost_records: Array<{ instance_name: string; before: number; after: number }>;
  /** Present before, absent after. Fine for a released instance that was
   *  empty; a defect for anything else. */
  gone: string[];
}

export function diffLedger(before: readonly InstanceLedgerRow[], after: readonly InstanceLedgerRow[]): LedgerDiff {
  const later = new Map(after.map((r) => [r.instance_name, r]));
  const out: LedgerDiff = { kept: [], re_created: [], lost_records: [], gone: [] };
  for (const b of before) {
    const a = later.get(b.instance_name);
    if (!a) {
      out.gone.push(b.instance_name);
      continue;
    }
    if (a.id !== b.id) {
      out.re_created.push({ instance_name: b.instance_name, before_id: b.id, after_id: a.id });
      continue;
    }
    if (b.records !== null && a.records !== null && a.records < b.records) {
      out.lost_records.push({ instance_name: b.instance_name, before: b.records, after: a.records });
      continue;
    }
    out.kept.push(a);
  }
  return out;
}

/** The one line the activity feed and the log carry: what moved, what stayed. */
export function describeFeatureChange(change: FeatureChange, diff: LedgerDiff, removedEmpty: readonly string[]): string {
  const parts: string[] = [];
  if (change.turned_on.length) parts.push(`on: ${change.turned_on.join(", ")}`);
  if (change.turned_off.length) parts.push(`off: ${change.turned_off.join(", ")}`);
  const records = diff.kept.reduce((n, r) => n + (r.records ?? 0), 0);
  if (diff.kept.length) parts.push(`kept ${diff.kept.length} table${diff.kept.length === 1 ? "" : "s"} with ${records} record${records === 1 ? "" : "s"}`);
  if (removedEmpty.length) parts.push(`removed empty: ${removedEmpty.join(", ")}`);
  if (diff.re_created.length) parts.push(`RE-CREATED: ${diff.re_created.map((r) => r.instance_name).join(", ")}`);
  if (diff.lost_records.length) parts.push(`LOST RECORDS: ${diff.lost_records.map((r) => `${r.instance_name} ${r.before} to ${r.after}`).join(", ")}`);
  return parts.join("; ") || "no change";
}
