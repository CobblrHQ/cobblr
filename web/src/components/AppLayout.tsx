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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CobblestoneMark } from "../CobblestoneMark";
import { NotificationsBell } from "./NotificationsBell";
import { DriveBanner } from "./DriveBanner";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { ModuleNav } from "./ModuleNav";
import { HeaderActions } from "./HeaderActions";
import { UserMenu } from "./UserMenu";
import { MobileNav } from "./MobileNav";
import { EmailVerifyBanner } from "./EmailVerifyBanner";
import { ChatWidget } from "./ChatWidget";
import { GlobalScanWedge } from "./GlobalScanWedge";
import { SearchBar } from "./SearchBar";
import { ErrorBoundary } from "./ErrorBoundary";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { getManagedAppMeta } from "../lib/managed-apps";
import { adminHtmlVars, fontFaceCss } from "../lib/appTheme";
import { useDeployEnv, DEFAULT_HEADER } from "../lib/deploy-env";

export function AppLayout({ activeSlug }: { activeSlug: string }) {
  const location = useLocation();
  const { activeOrg } = useActiveOrg();
  const qc = useQueryClient();
  // Managed-app mode: no workspace switching, no platform nav — just the app.
  const appMode = activeOrg?.app_mode ?? null;

  // Auto-update on use: once per session, ask the server to re-apply the latest
  // bundle if this managed app is behind. No-op when current; if it updated,
  // refetch so the new fields/views appear. Fire-and-forget — never blocks.
  useEffect(() => {
    if (!appMode || !activeSlug) return;
    const key = `cobblr.appRefreshed.${activeSlug}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    void api.refreshApp(activeSlug).then((r) => { if (r.updated) void qc.invalidateQueries(); }).catch(() => {});
  }, [appMode, activeSlug, qc]);

  // Workspace brand for the admin shell. The whole dashboard recolours to
  // `admin_theme` — page, header bar, every module page / card / table —
  // by overriding the semantic `--c-*` role tokens (the admin UI is built
  // on them). No remap, no !important. The Cobblr mark always stays;
  // button fills + form inputs keep their own non-semantic classes so
  // actions read on any palette.
  const config = useQuery({
    queryKey: ["portal-config", activeSlug],
    queryFn: () => api.getPortalConfig(activeSlug),
    enabled: !!activeSlug,
  });
  // A managed app wears its own author-defined palette (web-side registry) — it
  // takes precedence over (and managed apps never have) a workspace admin_theme.
  // Same `--c-*` override machinery below, so the whole locked shell recolours.
  const appMeta = appMode ? getManagedAppMeta(appMode.app) : null;
  const skin = appMeta?.theme ?? config.data?.config.admin_theme ?? null;
  // The header reads "[mark] cobblr <suffix>" (e.g. "for Yarn") — no repeated
  // "Cobblr". Prefer the registry's suffix; else strip a leading "Cobblr " off
  // the label as a fallback.
  const navSuffix = appMode ? appMeta?.navSuffix ?? (appMode.label ?? "").replace(/^cobblr\s+/i, "") : "";
  const wsLogo = config.data?.config.logo_path ?? null;
  const { badge: envBadge } = useDeployEnv();
  const fontFace = fontFaceCss(skin);

  // Publish the theme on <html> so the semantic tokens resolve to the
  // workspace palette AND modals/toasts that portal to <body> theme too.
  // Force light while themed — the tokens own the colours, so leaving the
  // user's `dark:` shade variants active would fight them. Everything is
  // restored on unmount (leaving for the portal/auth surface) or when the
  // theme is cleared, so nothing leaks onto another surface.
  useEffect(() => {
    const el = document.documentElement;
    const vars = adminHtmlVars(skin);
    if (!vars) return;
    const wasDark = el.classList.contains("dark");
    el.setAttribute("data-ws-themed", "");
    if (wasDark) el.classList.remove("dark");
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    return () => {
      el.removeAttribute("data-ws-themed");
      if (wasDark) el.classList.add("dark");
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
    <div className="min-h-screen grid grid-rows-[auto_1fr] grid-cols-1">
      {fontFace && <style dangerouslySetInnerHTML={{ __html: fontFace }} />}
      {/* Header + the email-verify nudge share the grid's auto row, so the
          banner doesn't consume the 1fr content row. */}
      <div className="min-w-0">
      {/* The root is grid-rows-[auto_1fr] = exactly two row-children
          (header, main). The accent strip lives INSIDE the header as its
          top edge — a third grid child would steal the 1fr row and
          stretch the header. A thin branded edge over the (still neutral +
          readable) functional header; the Cobblr mark stays. */}
      <header
        className={`relative z-30 border-b backdrop-blur overflow-x-clip ${envBadge ? envBadge.header : DEFAULT_HEADER}`}
        style={skin ? { borderTop: "4px solid var(--app-accent)" } : undefined}
      >
        <div className="max-w-6xl mx-auto px-5 py-3 flex items-center gap-2 sm:gap-3 min-w-0">
          {/* Brand — never compressed. Cobblr mark + wordmark always present. */}
          <Link
            to="/"
            className="relative flex items-center gap-2 shrink-0 hover:opacity-80 transition"
          >
            <CobblestoneMark size={26} />
            <span className="font-display font-extrabold text-content dark:text-mortar-100 lowercase">
              cobblr
            </span>
            {/* Managed app: the wordmark IS the "Cobblr", so append the suffix
                here ("for Yarn") instead of a separate label that repeats it. */}
            {appMode && navSuffix && (
              <span className="font-display font-extrabold text-content dark:text-mortar-100 truncate">
                {navSuffix}
              </span>
            )}
            {/* Mobile: overlay the env chip ON the wordmark (right-aligned) so
                it adds ZERO width — the navbar fits exactly as it does in prod,
                the chip can't push the right menu off-screen. */}
            {envBadge && (
              <span
                className={`sm:hidden absolute right-0 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 text-[9px] font-mono font-bold uppercase tracking-widest ${envBadge.chip}`}
              >
                {envBadge.label}
              </span>
            )}
          </Link>
          {/* Desktop: the chip sits inline beside the wordmark (room to spare). */}
          {envBadge && (
            <span
              className={`hidden sm:inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-widest ${envBadge.chip}`}
              title={`You are on the ${envBadge.label} environment — not production.`}
            >
              {envBadge.label}
            </span>
          )}
          {/* Platform workspace: a "/" divider + the workspace logo + switcher.
              A managed app shows none of this — its name is already the
              wordmark suffix ("cobblr for Yarn"), and there's nothing to
              switch to. */}
          {!appMode && (
            <>
              <span className="text-faint dark:text-slate-700 shrink-0">/</span>
              {/* Workspace logo — the builder's brand, alongside the Cobblr mark. */}
              {wsLogo && (
                <img
                  src={wsLogo}
                  alt=""
                  className="w-6 h-6 rounded object-contain shrink-0 border border-line dark:border-slate-700"
                />
              )}
              {/* min-w-0 (not shrink-0): if the row is still too tight, the
                  workspace name truncates here FIRST, keeping the right-side menu
                  button on-screen instead of clipping it. */}
              <div className="min-w-0">
                <WorkspaceSwitcher />
              </div>
            </>
          )}

          {/* Center nav (desktop): a single non-wrapping row. ModuleNav
              measures its own width and folds any links that don't fit
              into a trailing "more ▾" dropdown — so it never wraps to a
              second line (the author's ask) and nothing past the fold is lost.
              Hidden on mobile — MobileNav takes over. ModuleNav itself drops
              its platform affordances (dashboard, Configuration gear) in
              app mode. */}
          <nav className="hidden md:flex flex-nowrap items-center gap-0.5 flex-1 min-w-0">
            <ModuleNav />
          </nav>

          {/* Right cluster (desktop) — never shrinks. The cryptic icon
              row (super-admin / calendar / configuration / profile /
              theme / sign-out) is folded into UserMenu; scan, search +
              notifications stay as their own affordances. */}
          <div className="hidden md:flex items-center gap-1 shrink-0">
            {/* Module-contributed critical quick-actions (e.g. scan). */}
            <HeaderActions />
            <SearchBar />
            <NotificationsBell />
            {/* Ask-Cobblr launcher — a header button, not a floating FAB. */}
            <ChatWidget />
            <UserMenu themed={!!skin} />
          </div>

          {/* Mobile: spacer pushes the right cluster to the edge. The scan
              quick-action + AI launcher live here too (were desktop-only) so
              the phone navbar has the buttons, not just the hamburger. */}
          <div className="flex-1 md:hidden" />
          <div className="shrink-0 md:hidden flex items-center gap-0.5">
            <HeaderActions />
            <ChatWidget />
            <MobileNav />
          </div>
        </div>
      </header>

        <EmailVerifyBanner />
      </div>

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
      {/* App-wide hardware-scanner intake: a physical barcode scan registers
          from any screen (off the Scan tab) and always toasts — no silent drop.
          Stands down on the Scan page, which owns the wedge there. */}
      {activeSlug ? <GlobalScanWedge activeSlug={activeSlug} /> : null}
      {/* Feature 3: the drive prompt + green/red indicator (renders only when a
          drive grant is set and a session is live). */}
      <DriveBanner />
    </div>
  );
}
