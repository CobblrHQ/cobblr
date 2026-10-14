// The one settings surface a LOCKED managed app exposes. A managed app hides the
// whole platform (no Configuration), but a user still needs to tailor it — hide
// a table they don't use, turn the scanner off. This is that: a friendly
// show/hide list over the app's nav surfaces. Reachable at /me/app-settings
// (the /me/* prefix is already whitelisted by the app-mode route guard), so it
// works inside the lock-down. Nothing here deletes data — hiding a table just
// takes it off the menu; flip it back anytime.

import { Eye, EyeOff, Plus } from "lucide-react";
import { appsNotInMenu } from "@cobblr/platform-contract/app-catalog";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useNavModules, HEADING_PREFIX, NAVGROUP_PREFIX } from "../components/useNavModules";
import { useAppCatalog } from "../lib/appCatalog";
import { inManagedAppSurface } from "../lib/managed-apps";
import { useSidebarPin, useToggleNavHidden } from "../lib/moreApps";

export function AppSettingsPage() {
  const { activeSlug, activeOrg } = useActiveOrg();
  const toggleHidden = useToggleNavHidden();
  const pin = useSidebarPin();
  const { apps } = useAppCatalog();
  const { allTops, allChildrenByParent, allInstanceGroups, hiddenNames, isLoading } = useNavModules(activeSlug);
  const appLabel = activeOrg?.app_mode?.label ?? "this app";

  // Every destination, grouped the way the menu groups them: a heading or a
  // bundle's group is a label over its members (each one hideable on its own),
  // and a module's specialisations sit under it. Listing the top row alone
  // left every app under a heading with no way to hide it (#4143).
  const surfaces: Array<{ name: string; displayName: string; under?: string }> = [];
  for (const t of allTops) {
    if (t.name.startsWith(HEADING_PREFIX)) {
      for (const k of allChildrenByParent.get(t.name) ?? []) surfaces.push({ name: k.name, displayName: k.displayName, under: t.displayName });
    } else if (t.name.startsWith(NAVGROUP_PREFIX)) {
      const g = allInstanceGroups.get(t.name);
      for (const m of g?.members ?? []) surfaces.push({ name: m.name, displayName: m.displayName, under: g?.label ?? t.displayName });
    } else {
      surfaces.push({ name: t.name, displayName: t.displayName });
      for (const k of allChildrenByParent.get(t.name) ?? []) surfaces.push({ name: k.name, displayName: k.displayName, under: t.displayName });
    }
  }

  // Every other app that is on: in the registry, not yet a row of the menu.
  // Adding one makes it a row on every device's menu, the phone's included,
  // the same as its pin on All apps.
  const rowNames = new Set(surfaces.map((s) => s.name));
  const addable = appsNotInMenu(apps, rowNames).filter((a) => !activeOrg?.app_mode || inManagedAppSurface(a.route));

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted dark:text-slate-400">
        Nothing here deletes anything from {appLabel} - hidden surfaces can be turned back on anytime.
      </p>

      <div className="mt-6">
        <div className="mb-2 text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">
          Show in the menu
        </div>
        <ul className="divide-y divide-line dark:divide-slate-800 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
          {surfaces.length === 0 && (
            <li className="px-4 py-3 text-sm text-faint dark:text-slate-500">
              {isLoading ? "Loading…" : "Nothing to show yet. Your tables will appear here."}
            </li>
          )}
          {surfaces.map((t) => {
            const visible = !hiddenNames.has(t.name);
            return (
              <li key={t.name} className="flex items-center gap-3 px-4 py-3">
                <span className="flex-1 min-w-0 truncate text-sm text-content dark:text-mortar-100">
                  {t.under && <span className="text-faint dark:text-slate-500">{t.under} › </span>}
                  {t.displayName}
                </span>
                <button
                  type="button"
                  onClick={() => toggleHidden(activeSlug, t.name)}
                  aria-pressed={visible}
                  aria-label={`${visible ? "Hide" : "Show"} ${t.displayName}`}
                  title={visible ? "Hide from the menu" : "Show in the menu"}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    visible
                      ? "bg-cobble-600 text-white hover:bg-cobble-700"
                      : "bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400 hover:bg-line dark:hover:bg-slate-700"
                  }`}
                >
                  {visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  {visible ? "Shown" : "Hidden"}
                </button>
              </li>
            );
          })}
        </ul>
        {addable.length > 0 && (
          <>
            <div className="mt-6 mb-2 text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">
              Not in the menu
            </div>
            <ul className="divide-y divide-line dark:divide-slate-800 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900" data-testid="apps-not-in-menu">
              {addable.map((a) => (
                <li key={a.name} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex-1 min-w-0 truncate text-sm text-content dark:text-mortar-100">{a.label}</span>
                  <button
                    type="button"
                    onClick={() => pin(activeSlug, { label: a.label, names: [...new Set([a.key, a.name])] }, true)}
                    aria-label={`Add ${a.label} to the menu`}
                    title={`Add ${a.label} to the menu`}
                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400 hover:bg-line dark:hover:bg-slate-700 transition"
                  >
                    <Plus size={13} />
                    Add
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-2 text-[11px] text-faint dark:text-slate-500">
          Hiding the Scan Inbox turns off scanning; hiding a table (Hooks, Designs…) just tidies your menu - your items stay and reappear when you show it again.
        </p>
      </div>
    </div>
  );
}
