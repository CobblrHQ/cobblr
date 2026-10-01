// All apps: every app in the workspace, whatever its state, at the end of the
// sidebar's collections (⊞ More apps, #3883), as a grid of cards that uses a
// wide screen (#4046). The apps in your sidebar are grouped the way the
// sidebar groups them (sidebarGroups), then the ones that are on without a
// row of their own, the ones hidden here, and the ones that are off.
//
// A card is the app: the whole card opens it. The one other thing an app
// needs sits in the card's corner: on every app that is on, a pin, filled
// when the app is in this sidebar and an outline when it is not, that puts it
// in or takes it out (setInSidebar, the same rule the sidebar's own customise
// list uses, with an Undo); "Turn on" or "Ask an admin" on an app that is off.
// An app that was on but had no row (Files, Machines once its collections
// stood in for it) had no way into the sidebar from here (#4374).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Pin } from "lucide-react";
import { SearchInput, usePageTitle } from "@cobblr/platform-web";
import type { AppEntry } from "@cobblr/platform-contract/app-catalog";
import { useAppCatalog, useModuleDoor } from "../lib/appCatalog";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { surfaceTops, useNavModules } from "../components/useNavModules";
import { moduleIcon } from "../lib/module-icon";
import { sidebarGroups } from "../lib/sidebarGroups";
import { howToFindAnyApp, navWord, useSidebarPin } from "../lib/moreApps";
import { useNavLayout } from "../lib/nav-mode";
import { useIsDesktopWidth } from "../lib/useIsDesktopWidth";
import { QueryError } from "../components/QueryError";

type Rest = "on" | "hidden" | "off";
const REST: Array<{ key: Rest; title: (nav: string) => string; blurb: string }> = [
  { key: "on", title: (nav) => `On, not in your ${nav}`, blurb: "" },
  { key: "hidden", title: (nav) => `Hidden from your ${nav}`, blurb: "On in the workspace; you hid them on this device." },
  { key: "off", title: () => "Off in this workspace", blurb: "Turning one on adds it for everyone here." },
];

/** Does an app answer to what was typed: every word, in its name or what it does. */
function matches(a: AppEntry, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${a.label} ${a.description}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

const corner =
  "absolute right-2 top-2 inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium transition disabled:opacity-50";
/** The pin: a 44px target on a phone, the corner's size on a desk. */
const pinCorner = "absolute right-1 top-1 inline-flex h-11 w-11 items-center justify-center rounded-md transition md:right-2 md:top-2 md:h-8 md:w-8";

export function AllAppsPage() {
  usePageTitle("All apps");
  const { apps, loading, failed, retry } = useAppCatalog();
  const door = useModuleDoor();
  const { activeSlug, activeOrg } = useActiveOrg();
  const pin = useSidebarPin();
  const nav = useNavModules(activeSlug);
  const [q, setQ] = useState("");
  const desktop = useIsDesktopWidth();
  const navNoun = navWord(desktop, useNavLayout());

  // Where each app is in the sidebar, if it is: the group it sits under.
  const groups = useMemo(() => {
    const appMode = !!activeOrg?.app_mode;
    return sidebarGroups(surfaceTops(nav.tops, appMode), nav.childrenByParent, nav.instanceGroups, nav.doorNames, { homeRow: !appMode, flatLabel: `In your ${navNoun}`, placement: nav.placement });
  }, [nav.tops, nav.childrenByParent, nav.instanceGroups, nav.doorNames, nav.placement, activeOrg?.app_mode, navNoun]);
  const groupOf = (a: AppEntry): string | null => groups.find((g) => g.names.includes(a.name) || g.names.includes(a.key))?.label ?? null;
  // The name the sidebar knows the app's row by, which is what hiding writes.
  const rowName = (a: AppEntry): string => (groups.some((g) => g.names.includes(a.key)) ? a.key : a.name);

  const shown = q.trim() ? apps.filter((a) => matches(a, q)) : apps;
  const sections: Array<{ title: string; blurb?: string; apps: AppEntry[] }> = [
    ...groups.map((g) => ({ title: g.label, apps: shown.filter((a) => a.state === "on" && groupOf(a) === g.label) })),
    ...REST.map((r) => ({
      title: r.title(navNoun),
      blurb: r.key === "on" ? howToFindAnyApp(desktop) : r.blurb,
      apps: shown.filter((a) => (r.key === "on" ? a.state === "on" && groupOf(a) === null : a.state === r.key)),
    })),
  ].filter((s) => s.apps.length > 0);

  const card = (a: AppEntry) => {
    const Icon = moduleIcon(a.icon);
    const inSidebar = a.state === "on" && groupOf(a) !== null;
    const body = (
      <>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-subtle dark:bg-slate-800 text-accent">
          <Icon size={20} />
        </span>
        <span className="min-w-0 flex-1 pr-8">
          <span data-app-name className="block font-medium text-content dark:text-mortar-100">{a.label}</span>
          {a.description && <span data-app-description className="mt-0.5 text-xs text-muted dark:text-slate-400 line-clamp-2">{a.description}</span>}
        </span>
      </>
    );
    return (
      <li key={a.name} data-testid="app-row" data-state={a.state} className="relative">
        {a.state === "off" ? (
          <div className="flex h-full items-start gap-3 rounded-xl border border-dashed border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/60 p-4 opacity-80">
            {body}
          </div>
        ) : (
          <Link
            to={a.route}
            aria-label={`Open ${a.label}`}
            className="flex h-full items-start gap-3 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 transition hover:border-accent hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {body}
          </Link>
        )}
        {a.state !== "off" && (
          <button
            type="button"
            data-testid="app-pin"
            data-pinned={inSidebar ? "" : undefined}
            onClick={() => pin(activeSlug, { label: a.label, names: [...new Set([rowName(a), a.key, a.name])] }, !inSidebar)}
            aria-label={inSidebar ? `Remove ${a.label} from your ${navNoun}` : `Add ${a.label} to your ${navNoun}`}
            aria-pressed={inSidebar}
            title={inSidebar ? `Remove from your ${navNoun}` : `Add to your ${navNoun}`}
            className={`${pinCorner} ${inSidebar ? "text-accent" : "text-faint hover:text-accent"} hover:bg-subtle dark:hover:bg-slate-800`}
          >
            <Pin size={16} fill={inSidebar ? "currentColor" : "none"} />
          </button>
        )}
        {a.state === "off" &&
          (door.canTurnOn ? (
            <button type="button" disabled={door.busy} onClick={() => door.turnOn(a)} className={`${corner} bg-cobble-600 text-white hover:bg-cobble-700`}>
              Turn on
            </button>
          ) : (
            <button type="button" disabled={door.busy} onClick={() => door.ask(a)} className={`${corner} bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100`}>
              Ask an admin
            </button>
          ))}
      </li>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-content dark:text-mortar-100">All apps</h1>
          <p className="text-sm text-muted dark:text-slate-400">Everything this workspace can do, grouped the way your {navNoun} is.</p>
        </div>
        <SearchInput value={q} onChange={setQ} placeholder="Filter apps" aria-label="Filter apps" wrapperClassName="w-full sm:w-72" />
      </header>
      {loading && <p className="text-sm text-muted">Loading…</p>}
      {failed && <QueryError what="your apps" onRetry={retry} />}
      {!loading && q.trim() && sections.length === 0 && (
        <p className="rounded-xl border border-dashed border-line dark:border-slate-700 p-6 text-center text-sm text-muted dark:text-slate-400" data-testid="no-app-matches">
          No app matches “{q.trim()}”. {desktop ? "⌘K" : "Search in the menu"} searches your records too.
        </p>
      )}
      {sections.map((s) => (
        <section key={s.title} aria-label={s.title} className="space-y-2">
          <h2 className="text-[11px] font-mono uppercase tracking-widest text-faint">
            {s.title} <span className="text-muted">({s.apps.length})</span>
          </h2>
          {s.blurb && <p className="text-xs text-muted dark:text-slate-400">{s.blurb}</p>}
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-testid="app-grid">
            {s.apps.map(card)}
          </ul>
        </section>
      ))}
    </div>
  );
}
