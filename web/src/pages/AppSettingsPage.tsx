// The one settings surface a LOCKED managed app exposes. A managed app hides the
// whole platform (no Configuration), but a user still needs to tailor it — hide
// a table they don't use, turn the scanner off. This is that: a friendly
// show/hide list over the app's nav surfaces. Reachable at /me/app-settings
// (the /me/* prefix is already whitelisted by the app-mode route guard), so it
// works inside the lock-down. Nothing here deletes data — hiding a table just
// takes it off the menu; flip it back anytime.

import { Eye, EyeOff } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useNavModules, HEADING_PREFIX } from "../components/useNavModules";
import { toggleNavHidden } from "../lib/nav-order";

export function AppSettingsPage() {
  const { activeSlug, activeOrg } = useActiveOrg();
  const { allTops, hiddenNames, isLoading } = useNavModules(activeSlug);
  const appLabel = activeOrg?.app_mode?.label ?? "this app";

  // Real nav surfaces only — drop user-defined heading groups (they're
  // containers, not toggleable destinations).
  const surfaces = allTops.filter((t) => !t.name.startsWith(HEADING_PREFIX));

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
        Settings
      </h1>
      <p className="mt-1 text-sm text-muted dark:text-slate-400">
        Tailor {appLabel}. Hide what you don't use - nothing is deleted, and you can turn it back on anytime.
      </p>

      <div className="mt-6">
        <div className="mb-2 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
          Show in the menu
        </div>
        <ul className="divide-y divide-line dark:divide-slate-800 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
          {surfaces.length === 0 && (
            <li className="px-4 py-3 text-sm text-faint dark:text-slate-500">
              {isLoading ? "Loading…" : "Nothing to show yet — your tables will appear here."}
            </li>
          )}
          {surfaces.map((t) => {
            const visible = !hiddenNames.has(t.name);
            return (
              <li key={t.name} className="flex items-center gap-3 px-4 py-3">
                <span className="flex-1 min-w-0 truncate text-sm text-content dark:text-mortar-100">
                  {t.displayName}
                </span>
                <button
                  type="button"
                  onClick={() => toggleNavHidden(activeSlug, t.name)}
                  aria-pressed={visible}
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
        <p className="mt-2 text-[11px] text-faint dark:text-slate-500">
          Hiding the Scan Inbox turns off scanning; hiding a table (Hooks, Designs…) just tidies your menu - your items stay and reappear when you show it again.
        </p>
      </div>
    </div>
  );
}
