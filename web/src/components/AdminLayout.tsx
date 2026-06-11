// Platform-operator console shell — a SEPARATE interface from the workspace.
// Mounted as a sibling route (/admin/*) OUTSIDE AppLayout, mirroring the
// member-portal pattern (PortalLayout): same auth + data layer, deliberately
// different chrome. NO workspace switcher, NO module nav, NO tenant context —
// this is the cross-tenant operator surface, gated by is_platform_admin.
//
// The header wears a fixed slate "operator" skin (independent of the user's
// light/dark theme) so it's unmistakable you've left a workspace. The section
// content area (the Outlet) renders in the normal theme so the tables stay
// readable. See docs/modules/member-portal-and-permissions.md.

import { NavLink, Outlet } from "react-router-dom";
import { ArrowLeft, LogOut, Moon, ShieldCheck, Sun } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { ADMIN_SECTIONS } from "../lib/adminSections";

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
      <header className="bg-slate-900 text-mortar-100 border-b border-slate-700">
        {/* flex-wrap + the hidden-on-xs middle keep this row inside a phone
            viewport — the audit caught the control cluster pushing the page
            to 552px wide at 390px. */}
        <div className="max-w-6xl mx-auto px-5 py-3 flex flex-wrap items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 shrink-0 min-w-0">
            <ShieldCheck size={18} className="text-cobble-300" />
            <span className="font-display font-extrabold tracking-tight">
              Cobblr
            </span>
            <span className="text-slate-500 hidden sm:inline">·</span>
            <span className="text-mortar-200 font-medium hidden sm:inline">Operator Console</span>
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-cobble-400/40 bg-cobble-400/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-cobble-300">
              super-admin
            </span>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1 shrink-0">
            {/* Full navigation: "/" re-enters the workspace shell via the
                landing redirect (this router has no workspace routes). */}
            <a
              href="/"
              className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest text-slate-400 hover:text-mortar-100 transition px-2 py-1"
              title="Back to your workspace"
            >
              <ArrowLeft size={12} />
              Workspace
            </a>
            <span className="text-xs text-slate-400 hidden md:inline px-1">
              {user.display_name}
            </span>
            <button
              onClick={toggle}
              className="text-slate-400 hover:text-mortar-100 transition p-1.5"
              title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              onClick={logout}
              className="text-slate-400 hover:text-ember-400 transition p-1.5"
              title="Sign out"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>

        {/* Section nav — deep-linked /admin/<id>. */}
        {/* Mobile: one scrollable row (15 sections were eating half the
            screen as wrapped rows); desktop wraps as before. */}
        <nav className="max-w-6xl mx-auto px-5 flex flex-nowrap overflow-x-auto md:flex-wrap md:overflow-visible gap-0.5">
          {ADMIN_SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <NavLink
                key={s.id}
                to={`/admin/${s.id}`}
                className={({ isActive }) =>
                  "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition border-b-2 " +
                  (isActive
                    ? "border-cobble-400 text-mortar-100"
                    : "border-transparent text-slate-400 hover:text-mortar-200")
                }
              >
                <Icon size={12} />
                {s.label}
              </NavLink>
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
