// "Works with <page>": which bundles to suggest on a module's page, and what
// each one says about that page.
//
// A suggestion has to say why. "Pairs well with: Wine" on the Lists page read
// as a non sequitur, because nothing said what wine has to do with lists. The
// reason is never written for the strip: it is the `says` of the bundle's own
// wires that touch this page (an action on it, or an event from it), so it can
// only claim what installing the bundle actually does here. A bundle with no
// such sentence is not suggested on this page at all.
//
// Only core bundles that connect two or more modules, every one of them
// already switched on, none installed, none this workspace took out before,
// and none this person dismissed.

import type { FeaturedBundle } from "./featured-bundles";
import type { PlatformBundleManifest } from "./api";

type Wire = NonNullable<PlatformBundleManifest["wires"]>[number];

export interface WorksWithSuggestion {
  bundle: FeaturedBundle;
  /** One or two sentences, from the wires that touch this page. */
  says: string[];
}

/** The per-person dismissal, kept with the person's tips. */
export function worksWithTipId(bundleId: string): string {
  return `works-with:${bundleId.toLowerCase()}`.slice(0, 80);
}

/** Every wire a fresh install draws: the bundle's own, its instances', and
 *  those of the features that are on unless someone says no. */
function wiresOf(m: PlatformBundleManifest): Wire[] {
  const out: Wire[] = [...(m.wires ?? [])];
  for (const i of m.provides_instances ?? []) out.push(...(i.wires ?? []));
  for (const f of m.features ?? []) if (f.default !== false) out.push(...(f.wires ?? []));
  return out;
}

/** What the bundle says it does on this page: first a wire that acts on the
 *  page, then one the page sets off, so the two halves of a round trip ("goes
 *  on your list", "checking it off restocks") are what a person reads. */
export function saysAbout(m: PlatformBundleManifest, module: string): string[] {
  const into: string[] = [];
  const from: string[] = [];
  for (const w of wiresOf(m)) {
    if (!w.says) continue;
    if (w.action_id.startsWith(`${module}:`)) into.push(w.says);
    else if (w.trigger_event?.startsWith(`${module}.`)) from.push(w.says);
  }
  const picked = [into[0], from[0]].filter((s): s is string => !!s);
  return picked.length ? picked : [...into, ...from].slice(0, 2);
}

export function worksWithSuggestions(input: {
  module: string;
  featured: readonly FeaturedBundle[];
  enabled: ReadonlySet<string>;
  installed: ReadonlySet<string>;
  passed: ReadonlySet<string>;
  dismissed: Readonly<Record<string, unknown>>;
}): WorksWithSuggestion[] {
  const out: WorksWithSuggestion[] = [];
  for (const b of input.featured) {
    const m = b.manifest;
    // Only core bundles are pushed (docs/design-decisions/bundle-catalog-tiers.md).
    if ((m.catalog ?? "core") !== "core") continue;
    const reqs = (m.requires ?? []).map((r) => r.module);
    if (!reqs.includes(input.module) || reqs.length < 2) continue;
    if (!reqs.every((r) => input.enabled.has(r))) continue;
    if (input.installed.has(m.id) || input.passed.has(m.id)) continue;
    if (input.dismissed[worksWithTipId(m.id)]) continue;
    const says = saysAbout(m, input.module);
    if (says.length === 0) continue;
    out.push({ bundle: b, says });
  }
  // The one that does the most on this page first.
  return out.sort((a, b) => b.says.length - a.says.length || a.bundle.manifest.name.localeCompare(b.bundle.manifest.name));
}
