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

import {
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";

/** Props every dashboard widget receives. The active workspace slug plus a
 *  `getToken` (read fresh per request) are enough for a widget — including one
 *  living inside a packaged module, mounted by the host outside the module's
 *  own provider — to fetch its own count(s) with auth. Everything else it owns. */
export interface DashboardWidgetProps {
  slug: string;
  getToken: () => string | null;
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
  /** The tile component. Receives the active org slug; renders a DashboardTile. */
  component: ComponentType<DashboardWidgetProps>;
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
export function DashboardTile({
  to,
  icon: Icon,
  label,
  primary,
  secondary,
  attention,
}: {
  to: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  primary: ReactNode;
  secondary?: ReactNode;
  attention?: boolean;
}) {
  return (
    <Link
      to={to}
      className={
        "rounded-xl border bg-surface dark:bg-slate-900 p-4 hover:border-cobble-300 dark:hover:border-cobble-700 transition flex flex-col gap-2 " +
        (attention
          ? "border-ember-300 dark:border-ember-700"
          : "border-line dark:border-slate-700")
      }
    >
      <div className="flex items-center gap-2">
        <Icon size={14} className={attention ? "text-ember-500" : "text-accent"} />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
          {label}
        </span>
      </div>
      <div className="text-3xl font-semibold text-content dark:text-mortar-100 leading-none">
        {primary}
      </div>
      {secondary && (
        <div className="text-[11px] text-muted dark:text-slate-400">{secondary}</div>
      )}
    </Link>
  );
}
