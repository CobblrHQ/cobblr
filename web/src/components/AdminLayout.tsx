// Platform-operator console shell — a SEPARATE interface from the workspace.
// Mounted as a sibling route (/admin/*) OUTSIDE AppLayout, mirroring the
// member-portal pattern (PortalLayout): same auth + data layer, deliberately
// different chrome. NO workspace switcher, NO module nav, NO tenant context —
// this is the cross-tenant operator surface, gated by is_platform_admin.
//
// The header wears a distinct "operator" skin so it's unmistakable you've left
// a workspace — but it's THEME-AWARE: an elevated light surface with a cobble
// accent stripe in light mode, the slate skin in dark mode. (A fixed dark
// header left a jarring dark band across the top of an otherwise-light page.)
// The section content area (the Outlet) renders in the normal theme so the
// tables stay readable. See docs/modules/member-portal-and-permissions.md.

import { NavLink, Outlet } from "react-router-dom";
import { ArrowLeft, LogOut, Moon, ShieldCheck, Sun } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { ADMIN_GROUP_ORDER, ADMIN_SECTIONS } from "../lib/adminSections";

export function AdminLayout() {
  const { user, loading, logout } = useAuth();
  const { theme, toggle } = useTheme();

  // Wait for /me hydration before judging access — a direct load / fresh login
  // otherwise flashes "denied"/redirect until auth resolves.
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-faint font-mono text-xs">
        …
      </div>
    );
  }
  // Platform-operator only. The API already 403s non-admins on /super-admin/*;
  // this keeps them out of the shell entirely. FULL navigation, not an
  // in-router <Navigate>: the console is its own top-level router whose
  // catch-all is /admin/overview — an SPA redirect to "/" would loop.
  if (!user?.is_platform_admin) {
    window.location.replace("/");
    return null;
  }

  return (
    <div className="min-h-screen grid grid-rows-[auto_1fr] grid-cols-1 bg-canvas dark:bg-slate-950">
      <header className="bg-surface text-content border-b-2 border-cobble-500 dark:bg-slate-900 dark:text-mortar-100 dark:border-b dark:border-slate-700">
        {/* flex-wrap + the hidden-on-xs middle keep this row inside a phone
            viewport — the audit caught the control cluster pushing the page
            to 552px wide at 390px. */}
        <div className="max-w-6xl mx-auto px-5 py-3 flex flex-wrap items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 shrink-0 min-w-0">
            <ShieldCheck size={18} className="text-cobble-600 dark:text-cobble-300" />
            <span className="font-display font-extrabold tracking-tight">
              Cobblr
            </span>
            <span className="text-faint hidden sm:inline">·</span>
            <span className="text-muted font-medium hidden sm:inline">Operator Console</span>
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-cobble-500/40 bg-cobble-500/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-cobble-700 dark:border-cobble-400/40 dark:bg-cobble-400/10 dark:text-cobble-300">
              super-admin
            </span>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1 shrink-0">
            {/* Full navigation: "/" re-enters the workspace shell via the
                landing redirect (this router has no workspace routes). */}
            <a
              href="/"
              className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest text-faint hover:text-content transition px-2 py-1"
              title="Back to your workspace"
            >
              <ArrowLeft size={12} />
              Workspace
            </a>
            <span className="text-xs text-faint hidden md:inline px-1">
              {user.display_name}
            </span>
            <button
              onClick={toggle}
              className="text-faint hover:text-content transition p-1.5"
              title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              onClick={logout}
              className="text-faint hover:text-ember-500 dark:hover:text-ember-400 transition p-1.5"
              title="Sign out"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>

        {/* Section nav — deep-linked /admin/<id>. */}
        {/* Mobile: one scrollable row (15 sections were eating half the
            screen as wrapped rows); desktop wraps as before. */}
        {/* B5: 18 flat tabs were unscannable — cluster them under tiny group
            labels (registry-driven). Overview stays ungrouped up front. Same
            single scroll row on mobile; the labels ride along. */}
        <nav className="max-w-6xl mx-auto px-5 flex flex-nowrap overflow-x-auto md:flex-wrap md:overflow-visible items-end gap-0.5">
          {[undefined, ...ADMIN_GROUP_ORDER].map((g) => {
            const members = ADMIN_SECTIONS.filter((s) => s.group === g);
            if (members.length === 0) return null;
            return (
              <div key={g ?? "__front__"} className="flex flex-col shrink-0">
                <span className={"px-3 pt-1 text-[9px] font-mono uppercase tracking-widest " + (g ? "text-muted" : "text-transparent select-none")}>
                  {g ?? "·"}
                </span>
                <div className={"flex flex-nowrap gap-0.5 " + (g ? "border-l border-line dark:border-slate-700/60 ml-1 pl-1" : "")}>
                  {members.map((s) => {
                    const Icon = s.icon;
                    return (
                      <NavLink
                        key={s.id}
                        to={`/admin/${s.id}`}
                        className={({ isActive }) =>
                          "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition border-b-2 whitespace-nowrap " +
                          (isActive
                            ? "border-cobble-500 text-content dark:border-cobble-400 dark:text-mortar-100"
                            : "border-transparent text-faint hover:text-content dark:hover:text-mortar-200")
                        }
                      >
                        <Icon size={12} />
                        {s.label}
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
      </header>

      <main className="min-w-0">
        <div className="max-w-6xl mx-auto w-full px-5 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
