// Member portal shell — the slimmed-down front-end for non-admin
// users. Same auth + data layer as the admin shell; different chrome.
//
// What it strips out vs AppLayout: module nav, configuration link,
// search (for now), notifications bell.
//
// What it adds: a BRANDED shell. The per-workspace portal is the
// builder's, not Cobblr's (worker-navigation-and-identity.md §4), so it
// wears a full token theme — an explicit `portal_config.theme_tokens`
// override if set, otherwise INHERITED from the workspace's default-app
// (or sole-app) theme. Unthemed workspaces render in Cobblr chrome
// exactly as before. Header from portal_config (display_name, logo),
// curated nav from pinned_views, optional welcome markdown on the root.
//
// See docs/design-decisions/member-portal-and-permissions.md +
// worker-navigation-and-identity.md.

import { Link, Outlet, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Moon, Settings, Sun } from "lucide-react";
import { api, type AppTheme, type PortalConfig } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { fontFaceCss, mutedStyle, textStyle, themeWrapperStyle } from "../lib/appTheme";

export function PortalLayout() {
  const { slug } = useParams<{ slug: string }>();
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  const config = useQuery({
    queryKey: ["portal-config", slug],
    queryFn: () => api.getPortalConfig(slug!),
    enabled: !!slug,
  });

  const caps = useQuery({
    queryKey: ["my-capabilities", slug],
    queryFn: () => api.getMyCapabilities(slug!),
    enabled: !!slug,
  });

  // Apps the caller can open — used both to inherit the launcher skin and
  // (in PortalHomePage) to render the launcher tiles.
  const apps = useQuery({
    queryKey: ["portal-apps", slug],
    queryFn: () => api.listApps(slug!),
    enabled: !!slug,
  });

  // Admins/owners see a "Back to admin" link so they can hop between
  // shells without typing the URL.
  const isAdmin = caps.data?.role === "owner" || caps.data?.role === "admin";

  const portalConfig: PortalConfig = config.data?.config ?? { pinned_views: [] };
  const headerName = portalConfig.display_name || config.data?.org_name || "Portal";

  // ── Effective launcher theme ──────────────────────────────────────
  // Override wins; else inherit the default-app's (or the sole app's)
  // theme so the portal feels like the product, not Cobblr. null →
  // unchanged Cobblr chrome.
  const appItems = apps.data?.items ?? [];
  const inheritSlug =
    portalConfig.default_app && appItems.some((a) => a.slug === portalConfig.default_app)
      ? portalConfig.default_app
      : appItems.length === 1
        ? appItems[0]!.slug
        : null;
  const inherited = appItems.find((a) => a.slug === inheritSlug)?.theme ?? null;
  const skin: AppTheme | null = portalConfig.theme_tokens ?? inherited ?? null;
  const fontFace = fontFaceCss(skin);
  const headerLogo = portalConfig.logo_path || skin?.logo || null;

  return (
    <div
      className="min-h-screen grid grid-rows-[auto_1fr] grid-cols-1"
      style={themeWrapperStyle(skin)}
    >
      {fontFace && <style dangerouslySetInnerHTML={{ __html: fontFace }} />}
      <header
        className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/80 backdrop-blur"
        style={skin ? { background: "var(--app-surface)", borderColor: "var(--app-border)" } : undefined}
      >
        <div className="max-w-5xl mx-auto px-5 py-3 flex items-center gap-3 min-w-0">
          <Link
            to={`/portal/${slug}`}
            className="flex items-center gap-2 shrink-0 hover:opacity-80 transition min-w-0"
          >
            {headerLogo && (
              <img
                src={headerLogo}
                alt=""
                className="w-7 h-7 rounded object-cover border border-slate-200 dark:border-slate-700"
                style={skin ? { borderColor: "var(--app-border)" } : undefined}
              />
            )}
            <span
              className="font-display font-extrabold text-slate-700 dark:text-mortar-100 truncate"
              style={textStyle(skin)}
            >
              {headerName}
            </span>
          </Link>

          <div className="flex-1" />

          <div className="flex items-center gap-1 shrink-0">
            {isAdmin && (
              <button
                onClick={() => navigate("/")}
                className="text-[11px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 hover:text-cobble-600 transition px-2 py-1"
                style={mutedStyle(skin)}
                title="Switch to the admin shell"
              >
                <Settings size={11} className="inline -mt-0.5 mr-1" />
                admin
              </button>
            )}
            <span
              className="text-xs text-slate-500 dark:text-slate-400 hidden md:inline"
              style={mutedStyle(skin)}
            >
              {user?.display_name}
            </span>
            {/* A full skin owns the colours, so the per-user light/dark
                toggle would just fight it — hide it when themed. */}
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
              style={mutedStyle(skin)}
              title="Sign out"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </header>

      <main className="min-w-0">
        <div className="max-w-5xl mx-auto w-full px-5 py-6">
          <Outlet context={{ portalConfig, activeSlug: slug ?? null, skin }} />
        </div>
      </main>
    </div>
  );
}
