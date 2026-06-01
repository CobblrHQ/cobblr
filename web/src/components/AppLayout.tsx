// Authed app chrome. Header + module-aware nav + outlet for the
// current route. Borrows companion app's overflow-clip / min-w-0 / shrink-0
// layout so long nav lists can't push the page wider than the
// viewport.
//
// Nav hierarchy: ModuleNav reads /orgs/:slug/modules and groups
// enabled modules by their first dependency, putting Pillar-E
// specialisations (3D Printers, Laser Cutters, etc.) into a hover
// popover under the parent rather than as broken top-level links.

import { useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Moon, Server, Sun } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { CobblestoneMark } from "../CobblestoneMark";
import { NotificationsBell } from "./NotificationsBell";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { ModuleNav, ConfigurationLink } from "./ModuleNav";
import { HeaderActions } from "./HeaderActions";
import { MobileNav } from "./MobileNav";
import { SearchBar } from "./SearchBar";
import { ErrorBoundary } from "./ErrorBoundary";
import { api } from "../lib/api";
import { adminShellCss, fontFaceCss, themeVars } from "../lib/appTheme";

export function AppLayout({ activeSlug }: { activeSlug: string }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const location = useLocation();

  // Workspace brand for the admin shell. The whole dashboard recolours to
  // `admin_theme`: page background + accent + the workspace logo (chrome),
  // AND every module page / table / the header bar, via the scoped
  // utility-remap stylesheet (adminShellCss). The Cobblr mark always
  // stays. Button fills stay neutral (legible on any palette) — that seam
  // is where a future semantic-token migration takes over.
  const config = useQuery({
    queryKey: ["portal-config", activeSlug],
    queryFn: () => api.getPortalConfig(activeSlug),
    enabled: !!activeSlug,
  });
  const skin = config.data?.config.admin_theme ?? null;
  const wsLogo = config.data?.config.logo_path ?? null;
  const fontFace = fontFaceCss(skin);
  const recolor = adminShellCss(skin);

  // Publish the palette on <html data-ws-themed> so the scoped recolor
  // resolves its vars AND reaches modals/toasts that portal to <body>.
  // Cleaned up on unmount (leaving for the portal/auth surface) and when
  // the theme is cleared, so the marker never leaks onto another surface.
  useEffect(() => {
    const el = document.documentElement;
    const vars = themeVars(skin);
    if (!vars) return;
    el.setAttribute("data-ws-themed", "");
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, String(v));
    return () => {
      el.removeAttribute("data-ws-themed");
      for (const k of Object.keys(vars)) el.style.removeProperty(k);
    };
  }, [skin]);

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
    <div
      className="min-h-screen grid grid-rows-[auto_1fr] grid-cols-1"
      style={skin ? { ...themeVars(skin), background: "var(--app-bg)" } : undefined}
    >
      {(fontFace || recolor) && (
        <style dangerouslySetInnerHTML={{ __html: (fontFace ?? "") + (recolor ?? "") }} />
      )}
      {/* The root is grid-rows-[auto_1fr] = exactly two row-children
          (header, main). The accent strip lives INSIDE the header as its
          top edge — a third grid child would steal the 1fr row and
          stretch the header. A thin branded edge over the (still neutral +
          readable) functional header; the Cobblr mark stays. */}
      <header
        className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/80 backdrop-blur overflow-x-clip"
        style={skin ? { borderTop: "4px solid var(--app-accent)" } : undefined}
      >
        <div className="max-w-6xl mx-auto px-5 py-3 flex items-center gap-3 min-w-0">
          {/* Brand — never compressed. Cobblr mark always present. */}
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
          {/* Workspace logo — the builder's brand, alongside the Cobblr mark. */}
          {wsLogo && (
            <img
              src={wsLogo}
              alt=""
              className="w-6 h-6 rounded object-contain shrink-0 border border-slate-200 dark:border-slate-700"
            />
          )}
          <div className="shrink-0">
            <WorkspaceSwitcher />
          </div>

          {/* Center nav (desktop): a single non-wrapping row. ModuleNav
              measures its own width and folds any links that don't fit
              into a trailing "more ▾" dropdown — so it never wraps to a
              second line (the author's ask) and nothing past the fold is lost.
              Hidden on mobile — MobileNav takes over. */}
          <nav className="hidden md:flex flex-nowrap items-center gap-0.5 flex-1 min-w-0">
            <ModuleNav />
          </nav>

          {/* Right cluster (desktop) — never shrinks */}
          <div className="hidden md:flex items-center gap-1 shrink-0">
            {/* Module-contributed critical quick-actions (e.g. scan). */}
            <HeaderActions />
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
            {/* A workspace theme owns the palette, so the per-user
                light/dark toggle would just fight it — hide when themed. */}
            {!skin && (
              <button
                onClick={toggle}
                className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-mortar-100 transition p-1.5"
                title={theme === "dark" ? "Switch to light" : "Switch to dark"}
              >
                {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
              </button>
            )}
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
