// Scan confirm-form DESTINATION routing (pure, unit-tested).
//
// The confirm form's "Add to" picker must default to the table the matchmaker
// routed to. That routing used to break in one specific, invisible way: the
// workspace scan menu (with named instances like "Yarn") is fetched ASYNC, so
// while it loads the form fell back to a hardcoded generic menu with only the
// base tables. A yarn-routed scan therefore flashed "Inventory part" as the
// default, and a user who confirmed in that window filed the yarn into the
// generic inventory table (reported twice in beta). The fix seeds the
// routed live instance into the menu immediately from the candidate itself, so
// the default is correct on the FIRST render — no dependence on the network
// round-trip. These helpers are pure so the routing is asserted in tests.

import type { ScanCandidate, ScanMenuEntry } from "./api";

/** Selection key for a menu entry / candidate destination. */
export function entryKey(module: string, instance: string | null): string {
  // A module's own table is one table whether its instance is left out or
  // spelled as the module ("inventory"), as the server's tables name it: two
  // spellings were two keys, so the card did not find the row's destination
  // and named the top candidate instead (#6237).
  return `${module}::${instance && instance !== module ? instance : ""}`;
}

/** The Add to picker's tables with the apps the matchmaker offered to turn on,
 *  for someone who may install them (#6237). The offer leads when it IS the
 *  row's destination; otherwise the table that is on leads (an app is never
 *  turned on over one that fits, #6099) and the offer stays a choice after
 *  it, never dropped. `bundleMenu` is the offered tables with their fields. */
export function withInstallOffers<T extends ScanMenuEntry>(
  base: T[],
  candidates: readonly ScanCandidate[],
  bundleMenu: ReadonlyArray<ScanMenuEntry & { bundle_external_id?: string }>,
  opts: { canInstall: boolean; destinationBundle: string | null },
): Array<T | (ScanMenuEntry & { bundle_external_id?: string })> {
  if (!opts.canInstall) return base;
  const have = new Set(base.map((m) => entryKey(m.module, m.instance)));
  const offers = candidates
    .filter((c) => !!c.bundle_external_id)
    .flatMap((c) => bundleMenu.filter((m) => m.bundle_external_id === c.bundle_external_id && m.module === c.module && (m.instance ?? null) === (c.instance ?? null)))
    .filter((m, i, all) => !have.has(entryKey(m.module, m.instance)) && all.findIndex((o) => entryKey(o.module, o.instance) === entryKey(m.module, m.instance)) === i);
  const leading = offers.filter((m) => m.bundle_external_id === opts.destinationBundle);
  const after = offers.filter((m) => m.bundle_external_id !== opts.destinationBundle);
  return [...leading, ...base, ...after];
}

/** A placeholder menu entry synthesized from a routed LIVE-instance candidate.
 *  A candidate with no `bundle_external_id` points at a table that already
 *  exists in the workspace (its instance key came from the server scan menu),
 *  so it is safe to seed the picker with it before the async scan menu finishes
 *  loading. Field DEFS (`fields`) are left empty — they arrive with the real
 *  menu entry, which replaces this placeholder — but the destination's module /
 *  instance / kind (all the commit needs) are authoritative from the candidate. */
export function liveInstanceEntry(c: ScanCandidate): ScanMenuEntry {
  return {
    module: c.module,
    instance: c.instance,
    kind: c.kind,
    noun: c.label,
    label: c.label,
    fields: [],
  };
}

/** Merge placeholder entries for routed LIVE-instance candidates the base menu
 *  doesn't (yet) list. This closes the menu-load race that defaulted a
 *  named-instance route (a yarn scan) to the generic base table.
 *
 *  Only NAMED-instance candidates with no `bundle_external_id` are seeded:
 *   - a `bundle_external_id` candidate routes to a not-yet-installed bundle whose
 *     table does NOT exist — it must go through the install flow, never a direct
 *     commit, so seeding it would let the user file into a phantom table.
 *   - a module-DEFAULT candidate (no instance) is already the generic base table
 *     the fallback menu carries, so there is nothing to add.
 *
 *  Once the real menu loads it already contains the instance (with field defs),
 *  so the placeholder is dropped as a duplicate — the base entry wins. */
export function withRoutedInstances(
  base: ScanMenuEntry[],
  candidates: ScanCandidate[],
): ScanMenuEntry[] {
  const have = new Set(base.map((m) => entryKey(m.module, m.instance)));
  const extras: ScanMenuEntry[] = [];
  for (const c of candidates) {
    if (c.bundle_external_id || !c.instance) continue;
    const k = entryKey(c.module, c.instance);
    if (have.has(k)) continue;
    have.add(k);
    extras.push(liveInstanceEntry(c));
  }
  return extras.length ? [...base, ...extras] : base;
}

/** Which destination the confirm form defaults to. A routed target (a chip, the
 *  top candidate, or an `?into=` target) wins whenever it resolves to a real
 *  entry; otherwise fall back to a GENERIC default table — never an arbitrary
 *  named instance (a "Bookshelf" must not become the catch-all). Order: the AI's
 *  `entity_type` default, inventory's default, assets' default, ANY module
 *  default, then the first entry.
 *
 *  Pure so the routing is unit-tested — the yarn-routes-to-"Inventory part"
 *  regression was invisible precisely because this lived inline and nothing
 *  asserted on it. Callers should pass `entries` already run through
 *  `withRoutedInstances`, so a routed live instance resolves even mid-load. */
export function pickDestinationKey(opts: {
  initialKey: string | null;
  entries: ScanMenuEntry[];
  entityType?: string | null;
}): string {
  const { initialKey, entries, entityType } = opts;
  if (initialKey && entries.some((m) => entryKey(m.module, m.instance) === initialKey)) {
    return initialKey;
  }
  const isDefault = (m: ScanMenuEntry) => !m.instance;
  const pick =
    (entityType === "asset" && entries.find((m) => m.module === "assets" && isDefault(m))) ||
    entries.find((m) => m.module === "inventory" && isDefault(m)) ||
    entries.find((m) => m.module === "assets" && isDefault(m)) ||
    entries.find(isDefault) ||
    entries[0]!;
  return entryKey(pick.module, pick.instance);
}

/** Base-kind fallback for when the scan menu can't load: the menu
 *  (GET /modules/core-scan/menu) is the real source of truth and lists the
 *  workspace's ACTUAL tables ("Yarn"), not module names. */
export const FALLBACK_MENU: ScanMenuEntry[] = [
  { module: "inventory", instance: null, kind: "inventory:part", noun: "part", label: "Inventory part", fields: [] },
  { module: "assets", instance: null, kind: "assets:asset", noun: "asset", label: "Asset", fields: [] },
  { module: "machines", instance: null, kind: "machines:machine", noun: "machine", label: "Machine", fields: [] },
];

/** A table a scan row can be filed into, as every picker lists it. */
export type DestinationChoice = ScanCandidate & { key: string; installs: boolean };

/** Where a row can be filed, in the one order every picker shows (#6527):
 *  the row's own suggestions first (the ones that would fill something; the
 *  top one always), then every other table in the workspace's menu order.
 *  A split line's parent and its parts asked two pickers with two lists, a
 *  native one with the menu alone and the card's with the suggestions first,
 *  and the owner saw the same parts offered different tables. */
export function destinationChoices(menu: readonly ScanMenuEntry[] | null | undefined, candidates: readonly ScanCandidate[], name: string | null = null): DestinationChoice[] {
  const suggested = candidates.filter((c, i) => i === 0 || Object.keys(c.fields ?? {}).length > 0).slice(0, 3);
  const base = withRoutedInstances(menu && menu.length > 0 ? [...menu] : FALLBACK_MENU, [...suggested]);
  const seen = new Set(suggested.map((c) => entryKey(c.module, c.instance)));
  // A table picked by hand carries no matchmaker verdict: no extracted
  // fields, no confidence, no bundle to install.
  const rest = base
    .filter((m) => !seen.has(entryKey(m.module, m.instance)))
    .map((m) => ({ ...m, instance: m.instance ?? null, fields: {} as Record<string, string>, name: name ?? "", confidence: 0 }) as unknown as ScanCandidate);
  return [...suggested, ...rest].map((c) => ({ ...c, key: entryKey(c.module, c.instance), installs: !!c.bundle_external_id }));
}
