// Dashboard widget registry — the isolation-respecting seam for the home
// "at a glance" grid. Same shape as the file-preview registry: platform-web
// OWNS the registry; modules (and the host's built-ins) PUSH a widget in when
// their bundle loads; the Dashboard reads the registry and renders whichever
// widgets belong to an ENABLED module. Nobody imports the Dashboard, and the
// Dashboard imports no module — so a bundle-shipped or third-party module can
// add a glance tile with zero changes to the host.
//
// A widget is a small React component (given the active org slug) that renders
// a `DashboardTile` — a number worth glancing at + a deep link. Gating is by
// `module`: the Dashboard only mounts widgets whose owning module is enabled
// in the active workspace, so a registered-but-disabled module shows nothing.

import { createContext, type ComponentType, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";

/** A workspace instance of a multi-instance module (e.g. inventory's "Yarn"),
 *  as the host passes it to a per-instance tile. Structurally a subset of the
 *  kernel's ModuleInstance — platform-web stays free of the web app's api types. */
export interface DashboardInstance {
  instance_name: string;
  display_name: string;
  is_default: boolean;
  /** Primary-item count for this instance; null/undefined if the module reports none. */
  item_count?: number | null;
}

/** Props every dashboard widget receives. The active workspace slug plus a
 *  `getToken` (read fresh per request) are enough for a widget — including one
 *  living inside a packaged module, mounted by the host outside the module's
 *  own provider — to fetch its own count(s) with auth. Everything else it owns. */
export interface DashboardWidgetProps {
  slug: string;
  getToken: () => string | null;
  /** Set ONLY when the host has expanded an instanceable module into one tile
   *  per instance (see `instanceTile`). The aggregate `component` never sees it. */
  instance?: DashboardInstance;
}

export interface DashboardWidgetSpec {
  /** Owning module name (e.g. "inventory"). The Dashboard mounts this widget
   *  only when this module is enabled in the active workspace. */
  module: string;
  /** Stable id, unique across all widgets. Defaults to `module`. Lets a module
   *  contribute more than one tile, and gives Phase-2 layout a key to arrange. */
  id?: string;
  /** Sort hint within the grid; lower renders first. Default 100. */
  order?: number;
  /** The tile component. Receives the active org slug; renders a DashboardTile.
   *  For an instanceable module this is the FALLBACK (rendered only when the
   *  workspace has no instances / they haven't loaded). */
  component: ComponentType<DashboardWidgetProps>;
  /** Opt in to per-instance tiles: when set, the host fetches this module's
   *  instances and renders this component once per real instance (the stray
   *  empty default is dropped, mirroring the nav) instead of one aggregate tile —
   *  so a Yarn-bundle workspace reads "Yarn"/"Hooks", never the module name. The
   *  instance is passed via props.instance. */
  instanceTile?: ComponentType<DashboardWidgetProps>;
  /** Host-internal: the instance a per-instance tile represents. Set by the
   *  Dashboard's expansion, never by a module's register call. */
  _instance?: DashboardInstance;
}

const REGISTRY = new Map<string, DashboardWidgetSpec>();

let version = 0;
const listeners = new Set<() => void>();
function notify(): void {
  version += 1;
  // Refresh the cached snapshot HERE — registrations often happen at module
  // import (before any component has subscribed), so the cache must update on
  // every change, not only when a listener is attached.
  refresh();
  for (const l of listeners) l();
}

/** Register a dashboard glance widget. Called by a module's UI bundle (or the
 *  host's built-ins) at load. Re-registering the same id replaces it. */
export function registerDashboardWidget(spec: DashboardWidgetSpec): void {
  REGISTRY.set(spec.id ?? spec.module, spec);
  notify();
}

/** Remove a previously-registered widget by id (or module, if no explicit id
 *  was given). Mainly for tests / hot-reload symmetry. */
export function unregisterDashboardWidget(idOrModule: string): void {
  if (REGISTRY.delete(idOrModule)) notify();
}

function snapshot(): DashboardWidgetSpec[] {
  return [...REGISTRY.values()].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || (a.id ?? a.module).localeCompare(b.id ?? b.module),
  );
}

// Cache the sorted array so useSyncExternalStore's getSnapshot is referentially
// stable between notifies (a fresh array every call would loop-render).
// notify() keeps it current; defined as a function declaration so it's hoisted
// above notify()'s call site.
let cached: DashboardWidgetSpec[] = snapshot();
function refresh(): void {
  cached = snapshot();
}

/** All registered widgets, sorted by (order, id). Reactive: re-renders the
 *  caller when a widget registers/unregisters. The Dashboard filters this by
 *  its enabled-module set before mounting any. */
export function useDashboardWidgets(): DashboardWidgetSpec[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cached,
    () => cached,
  );
}

/** Uniform "at a glance" tile primitive so every widget reads as one rhythm,
 *  not a smorgasbord. A big primary number, an optional secondary line, an
 *  optional ember "attention" border, the whole card a deep link. The icon is
 *  passed in by the caller (platform-web stays lucide-free). */

/** Zero-tile collapse (dashboard audit 2026-07-03): a workspace with several
 *  enabled-but-empty modules burned a full tile row on zeros. The host grid
 *  provides this context; DashboardTile reports its emptiness and renders
 *  nothing when empty (outside Arrange mode) — the grid shows the empties as
 *  one quiet "Also enabled" line instead. No provider → tiles render normally. */
export interface TileCollapse {
  editing: boolean;
  reportEmpty: (label: string, to: string, empty: boolean) => void;
}
export const TileCollapseContext = createContext<TileCollapse | null>(null);

export function DashboardTile({
  to,
  icon: Icon,
  label,
  primary,
  primaryNoun,
  secondary,
  attention,
  empty,
}: {
  to: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  primary: ReactNode;
  /** What the big number COUNTS, when it is not simply all of them.
   *
   *  A tile labelled "purchases" showing 0 above "3 total" reads as a
   *  contradiction, because the 0 was open orders and nothing said so. Give the
   *  filtered number its noun and the two lines agree: "0 open" / "3 total". */
  primaryNoun?: string;
  secondary?: ReactNode;
  attention?: boolean;
  /** Explicitly "loaded and zero" — set by the widget (it knows its loading
   *  state; auto-detecting primary===0 would flicker-collapse during load). */
  empty?: boolean;
}) {
  const collapse = useContext(TileCollapseContext);
  useEffect(() => {
    if (!collapse) return;
    collapse.reportEmpty(label, to, !!empty);
    // Pull our entry on unmount. A multi-instance module mounts its AGGREGATE
    // tile while instances load, then swaps it for per-instance tiles; without
    // this cleanup the aggregate's "empty" report lingered in the host's "Also
    // enabled" line even though its tile was gone (the stale duplicate label).
    return () => collapse.reportEmpty(label, to, false);
  }, [collapse, label, to, empty]);
  if (empty && collapse && !collapse.editing) return null;
  // STAT-CHIP layout (prototype, the author sign-off pending): half the height of the
  // old tile — label + icon left, the number right on the same line, the
  // secondary fact underneath. Same grid, twice the density.
  return (
    <Link
      to={to}
      className={
        "rounded-lg border bg-surface dark:bg-slate-900 px-3 py-2.5 hover:border-cobble-300 dark:hover:border-cobble-700 transition flex flex-col gap-1 " +
        (attention
          ? "border-ember-300 dark:border-ember-700"
          : "border-line dark:border-slate-700")
      }
    >
      <div className="flex items-center gap-2">
        <Icon size={13} className={attention ? "text-ember-500" : "text-accent"} />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 truncate">
          {label}
        </span>
        <span className="ml-auto flex items-baseline gap-1 min-w-0">
          <span className="text-xl font-semibold text-content dark:text-mortar-100 leading-none">
            {primary}
          </span>
          {primaryNoun && (
            <span className="text-[10px] text-faint dark:text-slate-500 leading-none truncate">
              {primaryNoun}
            </span>
          )}
        </span>
      </div>
      {secondary && (
        <div className="text-[11px] text-muted dark:text-slate-400 truncate">{secondary}</div>
      )}
    </Link>
  );
}
