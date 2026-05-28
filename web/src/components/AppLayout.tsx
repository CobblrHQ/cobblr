// Authed app chrome. Header + module-aware nav + outlet for the
// current route. Borrows companion app's overflow-clip / min-w-0 / shrink-0
// layout so long nav lists can't push the page wider than the
// viewport.
//
// Nav hierarchy: ModuleNav reads /orgs/:slug/modules and groups
// enabled modules by their first dependency, putting Pillar-E
// specialisations (3D Printers, Laser Cutters, etc.) into a hover
// popover under the parent rather than as broken top-level links.

import { Link, Outlet, useLocation } from "react-router-dom";
import { LogOut, Moon, Server, Sun } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { CobblestoneMark } from "../CobblestoneMark";
import { NotificationsBell } from "./NotificationsBell";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { ModuleNav, ConfigurationLink } from "./ModuleNav";
import { MobileNav } from "./MobileNav";
import { SearchBar } from "./SearchBar";
import { ErrorBoundary } from "./ErrorBoundary";

export function AppLayout(_props: { activeSlug: string }) {
  // activeSlug is still threaded through from App.tsx for back-compat
  // but the bell + display-name link no longer need it (cross-
  // workspace notifications + /me/activity respectively).
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const location = useLocation();

  return (
    // grid-cols-1 pins the column to viewport width. We deliberately
    // do NOT set overflow-x on the outermost div — Chrome on macOS
    // suppresses the two-finger back/forward swipe gesture whenever
    // a page-level container clips horizontal overflow. The header
    // still clips its own nav (which scrolls horizontally), and
    // every page content is constrained by max-w-6xl + min-w-0 +
    // shrink-0 on flex children. If something does push wider than
    // viewport, that's a layout bug to fix locally rather than mask
    // here.
    <div className="min-h-screen grid grid-rows-[auto_1fr] grid-cols-1">
      <header className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/80 backdrop-blur overflow-x-clip">
        <div className="max-w-6xl mx-auto px-5 py-3 flex items-center gap-3 min-w-0">
          {/* Brand — never compressed */}
          <Link
            to="/"
            className="flex items-center gap-2 shrink-0 hover:opacity-80 transition"
          >
            <CobblestoneMark size={26} />
            <span className="font-display font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
              cobblr
            </span>
          </Link>
          <span className="text-slate-200 dark:text-slate-700 shrink-0">/</span>
          <div className="shrink-0">
            <WorkspaceSwitcher />
          </div>

          {/* Center nav (desktop): wraps to a second row when it
              overflows so every module link stays reachable. The old
              `overflow-x-auto no-scrollbar` scrolled horizontally with
              a hidden scrollbar, which left links past the fold (e.g.
              projects, purchases) unreachable. Hidden on mobile —
              MobileNav takes over. */}
          <nav className="hidden md:flex flex-wrap items-center gap-0.5 flex-1 min-w-0">
            <ModuleNav />
          </nav>

          {/* Right cluster (desktop) — never shrinks */}
          <div className="hidden md:flex items-center gap-1 shrink-0">
            <SearchBar />
            {user?.is_platform_admin && (
              <Link
                to="/super-admin"
                title="Platform-operator dashboards"
                className="text-slate-400 dark:text-slate-500 hover:text-cobble-600 transition p-1.5"
              >
                <Server size={14} />
              </Link>
            )}
            <ConfigurationLink />
            <NotificationsBell />
            <Link
              to="/me"
              className="text-xs text-slate-500 dark:text-slate-400 hidden md:inline hover:text-cobble-600 transition"
              title="Your profile + recent activity"
            >
              {user?.display_name}
            </Link>
            <button
              onClick={toggle}
              className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-mortar-100 transition p-1.5"
              title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              onClick={logout}
              className="text-slate-400 dark:text-slate-500 hover:text-ember-500 transition p-1.5"
              title="Sign out"
            >
              <LogOut size={14} />
            </button>
          </div>

          {/* Mobile: spacer pushes the hamburger to the right edge. */}
          <div className="flex-1 md:hidden" />
          <div className="shrink-0 md:hidden">
            <MobileNav />
          </div>
        </div>
      </header>

      <main className="min-w-0">
        <div className="max-w-6xl mx-auto w-full px-5 py-6">
          {/* Per-page boundary: a crash in one page shows a fallback but
              keeps the nav/chrome, and keying on pathname resets it when
              you navigate away. Also catches lazy-chunk load errors that
              the Suspense fallback doesn't. */}
          <ErrorBoundary key={location.pathname} scope="page">
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
