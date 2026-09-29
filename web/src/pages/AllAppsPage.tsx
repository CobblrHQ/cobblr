// All apps: every module in the workspace, whatever its state, at the end of
// the sidebar's collections (#3883). In the sidebar, hidden from it on this
// device, or off in the workspace; each with the one thing it needs.
import { usePageTitle } from "@cobblr/platform-web";
import type { AppEntry } from "@cobblr/platform-contract/app-catalog";
import { useAppCatalog, useModuleDoor } from "../lib/appCatalog";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useNavModules } from "../components/useNavModules";

// "In your sidebar" is what the sidebar actually draws (its rows, and the
// entries under them), read from the same hook it draws with. An app that is
// on but has no row of its own (files, tags, saved views: search-only by
// design) is listed on its own, not claimed to be in a sidebar it is not in.
type Section = "sidebar" | "on" | "hidden" | "off";
const SECTIONS: Array<{ key: Section; title: string; blurb: string }> = [
  { key: "sidebar", title: "In your sidebar", blurb: "" },
  { key: "on", title: "On, not in your sidebar", blurb: "Open them here, or find any of them with ⌘K." },
  { key: "hidden", title: "Hidden from your sidebar", blurb: "On in the workspace; you hid them on this device." },
  { key: "off", title: "Off in this workspace", blurb: "Turning one on adds it for everyone here." },
];

const btn =
  "inline-flex min-h-9 shrink-0 items-center rounded-md border px-3 py-1 text-sm font-medium transition disabled:opacity-50";

export function AllAppsPage() {
  usePageTitle("All apps");
  const { apps, loading } = useAppCatalog();
  const door = useModuleDoor();
  const { activeSlug } = useActiveOrg();
  const nav = useNavModules(activeSlug);
  const rows = new Set<string>();
  for (const t of nav.tops) rows.add(t.name);
  for (const kids of nav.childrenByParent.values()) for (const k of kids) rows.add(k.name);
  for (const g of nav.instanceGroups.values()) for (const m of g.members) rows.add(m.name);
  const sectionOf = (a: AppEntry): Section => (a.state !== "on" ? a.state : rows.has(a.name) || rows.has(a.key) ? "sidebar" : "on");
  const row = (a: AppEntry) => (
    <li key={a.name} data-testid="app-row" data-state={a.state} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <div className={`min-w-0 flex-1 ${a.state === "off" ? "opacity-70" : ""}`}>
        <div className="font-medium text-content dark:text-mortar-100">{a.label}</div>
        {a.description && <div className="text-xs text-muted dark:text-slate-400 line-clamp-2">{a.description}</div>}
      </div>
      {a.state !== "off" && (
        <button type="button" onClick={() => door.open(a)} className={`${btn} border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:border-accent`}>
          Open
        </button>
      )}
      {a.state === "hidden" && (
        <button type="button" onClick={() => door.showInSidebar(a)} className={`${btn} border-line dark:border-slate-600 text-muted hover:text-content`}>
          Show in sidebar
        </button>
      )}
      {a.state === "off" &&
        (door.canTurnOn ? (
          <button type="button" disabled={door.busy} onClick={() => door.turnOn(a)} className={`${btn} border-cobble-600 bg-cobble-600 text-white hover:bg-cobble-700`}>
            Turn on
          </button>
        ) : (
          <button type="button" disabled={door.busy} onClick={() => door.ask(a)} className={`${btn} border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100`}>
            Ask an admin
          </button>
        ))}
    </li>
  );
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100">All apps</h1>
        <p className="text-sm text-muted dark:text-slate-400">Everything this workspace can do, including what is not in your sidebar. ⌘K finds any of them by name too.</p>
      </header>
      {loading && <p className="text-sm text-muted">Loading…</p>}
      {SECTIONS.map((s) => {
        const list = apps.filter((a) => sectionOf(a) === s.key);
        if (!list.length) return null;
        return (
          <section key={s.key} aria-label={s.title} className="space-y-1.5">
            <h2 className="text-[11px] font-mono uppercase tracking-widest text-faint">
              {s.title} <span className="text-muted">({list.length})</span>
            </h2>
            {s.blurb && <p className="text-xs text-muted dark:text-slate-400">{s.blurb}</p>}
            <ul className="divide-y divide-line dark:divide-slate-800 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
              {list.map(row)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
