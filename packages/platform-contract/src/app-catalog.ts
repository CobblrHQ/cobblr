// Every module a person could go looking for, and where it stands: on and in
// the sidebar, on but hidden from it, or off.
//
// The owner could not find Purchases once it was not in his nav (#3883): a
// module missing from the sidebar was reachable only by knowing its address,
// and one that was off could only be turned on from Configuration → Modules,
// which is not where anybody looks. The search palette, the All apps page and
// the guard that every module is findable read this ONE rule, so the three can
// never disagree about what is an app.
//
// A module is an app unless it is plumbing: a `core-*` or foundational module
// that declares no page of its own (`nav`). A plumbing module has nowhere to
// open; everything else is one search away whatever its state.

export interface AppModuleLike {
  name: string;
  displayName: string;
  description?: string | null;
  band?: string | null;
  enabled: boolean;
  nav?: { label: string; route: string; icon?: string | null } | null;
  /** The module's icon name (kebab-case lucide), the one the sidebar shows. */
  icon?: string | null;
}

export type AppState = "on" | "hidden" | "off";

export interface AppEntry {
  /** The module's name: what turning it on names. */
  name: string;
  label: string;
  /** Where it opens: its declared page, else `/<name>`. */
  route: string;
  /** The nav's own token for it (the route's first segment): what the
   *  sidebar's per-device hide list holds. */
  key: string;
  state: AppState;
  /** The icon the sidebar shows for it (its nav entry's, else the module's). */
  icon: string | null;
  description: string;
  /** Everything a person might type for it, lower-cased. */
  words: string;
}

export function isAppPlumbing(m: Pick<AppModuleLike, "name" | "band" | "nav">): boolean {
  return (m.name.startsWith("core-") || m.band === "foundational") && !m.nav;
}

/** The apps, in label order. `hidden` is the sidebar's per-device hide list
 *  (nav keys): an enabled module named there is "hidden", one tap from
 *  showing again. */
export function appCatalog(modules: readonly AppModuleLike[], hidden: ReadonlySet<string> = new Set()): AppEntry[] {
  const out: AppEntry[] = [];
  const seen = new Set<string>();
  for (const m of modules) {
    if (isAppPlumbing(m) || seen.has(m.name)) continue;
    seen.add(m.name);
    const route = m.nav?.route || `/${m.name}`;
    const key = route.replace(/^\//, "").split("/")[0] || m.name;
    const label = m.nav?.label || m.displayName || m.name;
    // The sidebar hides a row by its own name, which for a module is its route
    // word and for an app inside a group (a lens, a bundle's heading) is the
    // module's name: either one means hidden.
    const state: AppState = !m.enabled ? "off" : hidden.has(key) || hidden.has(m.name) ? "hidden" : "on";
    const words = [label, m.displayName, m.name.replace(/-/g, " "), m.description ?? ""].join(" ").toLowerCase();
    out.push({ name: m.name, label, route, key, state, icon: m.nav?.icon || m.icon || null, description: m.description ?? "", words });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** The apps a search finds: every word typed appears in what the app answers
 *  to. A label that starts with what was typed leads. */
export function appsMatching(q: string, apps: readonly AppEntry[], limit = 6): AppEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = apps.filter((a) => words.every((w) => a.words.includes(w)));
  const lead = (a: AppEntry) => (a.label.toLowerCase().startsWith(words[0]!) ? 0 : 1);
  return hits.sort((a, b) => lead(a) - lead(b) || a.label.localeCompare(b.label)).slice(0, limit);
}

export const MODULE_ROUTE_OWNERS: ReadonlyArray<{ route: string; module: string }> = [
  { route: "/station/floor", module: "digifab" },
  { route: "/station/printer", module: "digifab" },
  { route: "/station/machine", module: "digifab" },
];

/** Module ownership also covers pages outside a module's usual address. */
export function moduleForRoute(pathname: string, modules: readonly { name: string; nav?: { route?: string } | null }[]): string | null {
  const roots = [
    ...MODULE_ROUTE_OWNERS,
    ...modules.flatMap(m => [
      { route: `/${m.name}`, module: m.name },
      ...(m.nav?.route ? [{ route: m.nav.route, module: m.name }] : []),
    ]),
  ];
  let owner: string | null = null;
  let length = 0;
  for (const entry of roots) {
    const root = entry.route.replace(/\/\*$/, "").replace(/\/$/, "");
    if (root.length > length && (pathname === root || pathname.startsWith(`${root}/`))) {
      owner = entry.module;
      length = root.length;
    }
  }
  return owner;
}
