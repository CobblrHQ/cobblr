// Per-instance dashboard tiles. A multi-instance module (inventory, projects)
// auto-creates a default instance named after the module, then the user adds
// named ones (a Yarn bundle → "Yarn" + "Hooks"). A single aggregate tile labelled
// with the MODULE name ("Inventory") is wrong in that world — the user thinks in
// "Yarn", not "Inventory". So when a module opts in via `instanceTile`, the host
// expands its one tile into one tile per REAL instance.
//
// "Real" = mirror the nav's defaultModuleEntriesToHide exactly: drop the stray
// auto-created default ONLY when it's empty AND named instances exist. A plain
// inventory workspace with no bundles still shows its default "Inventory" tile;
// a default that holds data is never hidden.
//
// Pure + module-agnostic (instances are a kernel concept the nav already expands
// the same way) so it unit-tests without React. The host feeds it the live
// instances per module; the per-instance RENDERING stays in the module's
// `instanceTile` component (icon, count source, deep link), passed the instance.

import type { DashboardWidgetSpec } from "@cobblr/platform-web";
import type { ModuleInstance } from "../lib/api";

/** Stable tile id for one instance of a module. `::inst::` can't collide with a
 *  module name or another widget's id. */
export const instanceTileId = (module: string, instanceName: string): string =>
  `${module}::inst::${instanceName}`;

/** Replace each instanceable widget with one spec per real instance. Widgets
 *  without `instanceTile`, or whose instances haven't loaded yet (`undefined`),
 *  pass through unchanged so the aggregate tile shows until expansion is ready. */
export function expandInstanceWidgets(
  widgets: DashboardWidgetSpec[],
  instancesByModule: Map<string, ModuleInstance[] | undefined>,
): DashboardWidgetSpec[] {
  const out: DashboardWidgetSpec[] = [];
  for (const w of widgets) {
    const insts = w.instanceTile ? instancesByModule.get(w.module) : undefined;
    // No opt-in, or not loaded yet → keep the aggregate tile.
    if (!w.instanceTile || insts === undefined) {
      out.push(w);
      continue;
    }
    const hasNamed = insts.some((i) => !i.is_default);
    const shown = insts.filter(
      (i) => !(i.is_default && hasNamed && i.item_count === 0),
    );
    // Nothing to show (shouldn't happen — a default always exists) → fall back.
    if (shown.length === 0) {
      out.push(w);
      continue;
    }
    // Named instances first (alpha), the default ("Inventory") last — it's the
    // catch-all, least interesting once you have named domains.
    const ordered = [...shown].sort(
      (a, b) =>
        Number(a.is_default) - Number(b.is_default) ||
        a.display_name.localeCompare(b.display_name),
    );
    for (const inst of ordered) {
      out.push({
        module: w.module,
        id: instanceTileId(w.module, inst.instance_name),
        order: w.order,
        component: w.instanceTile,
        _instance: inst,
      });
    }
  }
  return out;
}
