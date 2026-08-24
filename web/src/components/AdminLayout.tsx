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

function AdminNavRow({ section }: { section: (typeof ADMIN_SECTIONS)[number] }) {
  const Icon = section.icon;
  return (
    <NavLink
      to={`/admin/${section.id}`}
      className={({ isActive }) =>
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition min-w-0 " +
        (isActive
          ? "bg-cobble-100 text-accent dark:bg-cobble-900/40 dark:text-mortar-100"
          : "text-faint hover:text-content hover:bg-subtle dark:hover:text-mortar-200 dark:hover:bg-slate-800")
      }
    >
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{section.label}</span>
    </NavLink>
  );
}

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
    <div className="min-h-screen flex bg-canvas dark:bg-slate-950">
      {/* The rail. 18 sections in 5 clusters were wrapping into two rows of tiny
          tabs that pushed the page content below the fold and re-flowed as the
          window resized. A vertical rail gives every cluster its heading, keeps
          the whole map visible at once, and matches the workspace shell's own
          sidebar so the operator console stops feeling like a different app. */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-line dark:border-slate-800 bg-surface dark:bg-slate-900">
        <div className="px-4 py-3 border-b border-line dark:border-slate-800">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck size={18} className="text-cobble-600 dark:text-cobble-300 shrink-0" />
            <span className="font-display font-extrabold tracking-tight truncate">Cobblr</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-cobble-500/40 bg-cobble-500/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-cobble-700 dark:border-cobble-400/40 dark:bg-cobble-400/10 dark:text-cobble-300">
              super-admin
            </span>
          </div>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-3">
          {[undefined, ...ADMIN_GROUP_ORDER].map((g) => {
            const members = ADMIN_SECTIONS.filter((s) => s.group === g);
            if (members.length === 0) return null;
            return (
              <div key={g ?? "__front__"}>
                {g && (
                  <div className="px-2 pb-1 text-[9px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                    {g}
                  </div>
                )}
                <div className="space-y-0.5">
                  {members.map((s) => (
                    <AdminNavRow key={s.id} section={s} />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-line dark:border-slate-800 px-2 py-2 space-y-0.5">
          <a
            href="/"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-faint hover:text-content hover:bg-subtle dark:hover:bg-slate-800 transition"
            title="Back to your workspace"
          >
            <ArrowLeft size={14} className="shrink-0" />
            Workspace
          </a>
          <button
            onClick={toggle}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-faint hover:text-content hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            {theme === "dark" ? <Sun size={14} className="shrink-0" /> : <Moon size={14} className="shrink-0" />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-faint hover:text-ember-500 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            <LogOut size={14} className="shrink-0" />
            <span className="truncate">Sign out</span>
          </button>
          <div className="px-2 pt-1 text-[10px] text-faint dark:text-slate-600 truncate">
            {user.display_name}
          </div>
        </div>
      </aside>

      {/* Phone: no rail. One scrolling row of sections under a compact bar,
          which is what a phone can actually carry. */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden bg-surface dark:bg-slate-900 border-b-2 border-cobble-500 dark:border-b dark:border-slate-700">
          <div className="px-4 py-2.5 flex items-center gap-2 min-w-0">
            <ShieldCheck size={16} className="text-cobble-600 dark:text-cobble-300 shrink-0" />
            <span className="font-display font-extrabold tracking-tight text-sm">Cobblr</span>
            <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-700 dark:text-cobble-300">
              super-admin
            </span>
            <div className="flex-1" />
            <a href="/" className="text-faint hover:text-content transition p-1" title="Back to your workspace">
              <ArrowLeft size={14} />
            </a>
            <button onClick={toggle} className="text-faint hover:text-content transition p-1">
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button onClick={logout} className="text-faint hover:text-ember-500 transition p-1">
              <LogOut size={14} />
            </button>
          </div>
          <nav className="flex flex-nowrap overflow-x-auto gap-0.5 px-2">
            {ADMIN_SECTIONS.map((s) => {
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
          </nav>
        </header>

        <main className="flex-1 min-w-0">
          <div className="max-w-6xl mx-auto w-full px-5 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
