// Authed app chrome. Header + module-aware nav + outlet for the
// current route. Borrows companion app's overflow-clip / min-w-0 / shrink-0
// layout so long nav lists can't push the page wider than the
// viewport.
//
// Nav hierarchy: ModuleNav reads /orgs/:slug/modules and groups
// enabled modules by their first dependency, putting Pillar-E
// specialisations (3D Printers, Laser Cutters, etc.) into a hover
// popover under the parent rather than as broken top-level links.

import { Link, Outlet } from "react-router-dom";
import { LogOut, Moon, Sun } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { CobblestoneMark } from "../CobblestoneMark";
import { NotificationsBell } from "./NotificationsBell";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { ModuleNav, ConfigurationLink } from "./ModuleNav";
import { MobileNav } from "./MobileNav";

export function AppLayout({ activeSlug }: { activeSlug: string }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();

  return (
    // grid-cols-1 pins the column to viewport width; overflow-x-clip
    // belts-and-suspenders against any child trying to push wider.
    <div className="min-h-screen grid grid-rows-[auto_1fr] grid-cols-1 overflow-x-clip">
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

          {/* Center nav (desktop): scrolls horizontally if it
              overflows. Hidden on mobile — MobileNav takes over. */}
          <nav className="hidden md:flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto no-scrollbar">
            <ModuleNav />
          </nav>

          {/* Right cluster (desktop) — never shrinks */}
          <div className="hidden md:flex items-center gap-1 shrink-0">
            <ConfigurationLink />
            <NotificationsBell slug={activeSlug} />
            <span
              className="text-xs text-slate-500 dark:text-slate-400 hidden md:inline"
              title={activeSlug}
            >
              {user?.display_name}
            </span>
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

      <main className="min-w-0 overflow-x-hidden">
        <div className="max-w-6xl mx-auto w-full px-5 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
