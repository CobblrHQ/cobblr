// Authed app chrome. Header + module-aware nav + outlet for the
// current route. Uses an overflow-clip / min-w-0 / shrink-0
// layout so long nav lists can't push the page wider than the
// viewport.
//
// Nav hierarchy: ModuleNav reads /orgs/:slug/modules and groups
// enabled modules by their first dependency, putting Pillar-E
// specialisations (3D Printers, Laser Cutters, etc.) into a hover
// popover under the parent rather than as broken top-level links.

import { useEffect, useRef, useState } from "react";
import { Moon, PanelLeft, PanelTop, Pin, PinOff, Sliders, Sun, UserRound } from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Search } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CobblestoneMark } from "../CobblestoneMark";
import { DesktopDragStrip } from "./DesktopDragStrip";
import { NotificationsBell } from "./NotificationsBell";
import { DriveProvider } from "./DriveContext";
import { LiveBox } from "./LiveBox";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { ModuleNav } from "./ModuleNav";
import { SidebarNav } from "./SidebarNav";
import { HeaderActions } from "./HeaderActions";
import { UserMenu } from "./UserMenu";
import { MobileNav } from "./MobileNav";
import { EmailVerifyBanner } from "./EmailVerifyBanner";
import { SimpleModeNotice } from "./SimpleModeNotice";
import { ChatLauncher, ChatPanel } from "./ChatWidget";
import { FeedbackWidget } from "./FeedbackWidget";
import { GlobalScanWedge } from "./GlobalScanWedge";
import { SearchBar } from "./SearchBar";
import { CommandPalette, OPEN_PALETTE_EVENT } from "./CommandPalette";
import { NewVersionNudge } from "./NewVersionNudge";
import { QuickAccess } from "./QuickAccess";
import { ErrorBoundary } from "./ErrorBoundary";
import { LabelsBasket } from "@cobblr/labels/ui";
import { api, getToken, isFocused } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import { useWorkspaceContentProbe } from "../lib/workspaceContent";
import { getManagedAppMeta } from "../lib/managed-apps";
import { adminHtmlVars, fontFaceCss } from "../lib/appTheme";
import { useDeployEnv, DEFAULT_HEADER } from "../lib/deploy-env";
import { useNavMode, useNavAutoHide, useNavTopBar, setNavMode, setNavAutoHide, setNavTopBar } from "../lib/nav-mode";
import { GuidedTour } from "../tour/GuidedTour";
import { useTour } from "../tour/useTour";
import { DASHBOARD_TOUR } from "../tour/tour.config";
import { useTheme } from "../theme/ThemeContext";
import { useToast } from "@cobblr/platform-web";
import { readOpenOn, restoresOn, writeOpenOn } from "../lib/panel-memory";

export function AppLayout({ activeSlug }: { activeSlug: string }) {
  const location = useLocation();
  // Ask-Cobblr panel open state, lifted here so the main content shifts left
  // (into its centering margin) when the panel opens, instead of being overlaid.
  //
  // Restored across a refresh, but only on the page it was open on: a panel
  // that reappears everywhere is something you have to keep closing, which is
  // worse than losing it. location.pathname is the ROUTER path, so the
  // `/w/<handle>` basename is already gone and the same page in two workspaces
  // is one place. See lib/panel-memory.
  const [chatOpen, setChatOpen] = useState(() => restoresOn(readOpenOn(), location.pathname));
  useEffect(() => {
    writeOpenOn(chatOpen ? location.pathname : null);
  }, [chatOpen, location.pathname]);
  // Vivaldi-style nav placement: the module nav lives in the top bar (default)
  // or a skinny left sidebar; the tiny panel icon left of the wordmark flips
  // it, and the sidebar itself can be pinned or auto-hiding (its pin footer).
  // Per-device preferences, like the digifab tab memory.
  const navMode = useNavMode();
  const navAutoHide = useNavAutoHide();
  const navTopBar = useNavTopBar();
  const { theme, toggle: toggleTheme } = useTheme();
  const flipNavMode = () => setNavMode(navMode === "top" ? "side" : "top");
  const flipAutoHide = () => setNavAutoHide(!navAutoHide);
  const flipTopBar = () => setNavTopBar(!navTopBar);
  // The auto-hiding panel must start BELOW the header (else sliding out covers
  // the nav toggle — and you can't reach the toggle without crossing the hover
  // strip that opens the panel). Header height varies (env chip, banners) and
  // it scrolls away, so track its live bottom edge instead of guessing.
  const headerRef = useRef<HTMLElement>(null);
  const [hideTop, setHideTop] = useState(56);
  // Tracked ALWAYS (not just in auto-hide mode) because it is also published as
  // --app-header-bottom, which every overlay that must sit under the navbar
  // reads — SidePanel's mobile sheet above all. Header height moves with the
  // env chip, banners and the safe-area inset, so measuring beats guessing.
  const trackHideTop = navMode === "side" && navAutoHide;

  // MOBILE: the top bar is the only navigation there — workspace switcher, scan,
  // Ask Cobb and the menu — and it used to scroll away, so on a long list all
  // four were unreachable without scrolling back to the top. It is now fixed and
  // hides on the way DOWN, returning on any upward flick: the standard phone
  // pattern, and the reason it is not simply pinned is that ~56px of permanent
  // chrome is a lot of a phone screen on the list views this app is mostly made
  // of.
  //
  // `fixed`, not `sticky`: this header sits in the grid's auto row, whose box is
  // only as tall as the header itself, so a sticky element would have no room to
  // stick within and would scroll away regardless.
  const [barHidden, setBarHidden] = useState(false);
  const barHiddenRef = useRef(false);
  const [barH, setBarH] = useState(56);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    let queued = 0;
    const measure = () => {
      queued = 0;
      const bottom = Math.max(0, el.getBoundingClientRect().bottom);
      // Height, not bottom: the spacer that holds the fixed bar's place. Set
      // from here (rAF-coalesced, and only on a real change) rather than on
      // every scroll frame, which would re-render the whole app tree.
      setBarH((h) => (Math.abs(h - el.offsetHeight) > 1 ? el.offsetHeight : h));
      // A CSS var costs no render, so it updates for everyone. React state is
      // only for the auto-hide panel — setting it on every scroll frame would
      // re-render the whole app tree.
      document.documentElement.style.setProperty("--app-header-bottom", `${bottom}px`);
      if (trackHideTop) setHideTop(bottom);
    };
    const update = () => { if (!queued) queued = requestAnimationFrame(measure); };
    // Direction, with a dead zone so a jittery finger does not flap the bar.
    let lastY = window.scrollY;
    const onScroll = () => {
      // PHONE ONLY. Above md the bar is simply pinned, and this must not run at
      // all there: it re-rendered the whole app tree on every scroll direction
      // change, and a transform on a fixed, backdrop-blurred, composited bar made
      // it visibly ride the page instead of sitting still. Desktop now carries no
      // transform and no transition (max-md: on both), so there is nothing left
      // to animate or to repaint.
      if (window.innerWidth >= 768) {
        if (barHiddenRef.current) { barHiddenRef.current = false; setBarHidden(false); }
        return;
      }
      const y = window.scrollY;
      const dy = y - lastY;
      if (Math.abs(dy) < 6) return;
      lastY = y;
      // Always present at the top of a page, and never hidden when there is not
      // enough scrolled past it to hide behind.
      const next = y > barH + 8 && dy > 0;
      // Only re-render on a real change: this fires on every scroll frame.
      if (next !== barHiddenRef.current) { barHiddenRef.current = next; setBarHidden(next); }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    measure();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      if (queued) cancelAnimationFrame(queued);
      ro.disconnect();
      window.removeEventListener("scroll", update);
      window.removeEventListener("scroll", onScroll);
      document.documentElement.style.removeProperty("--app-header-bottom");
    };
  }, [trackHideTop]);
  const { activeOrg } = useActiveOrg();
  const qc = useQueryClient();
  // Managed-app mode: no workspace switching, no platform nav — just the app.
  const appMode = activeOrg?.app_mode ?? null;
  // First-load guided tour: auto-opens once per USER, on the dashboard of a
  // still-EMPTY workspace only (the first-run hero state) - never over an
  // established one. Replays from the account menu. Steps: tour/tour.config.ts.
  const onDashboard = location.pathname === "/" && !appMode;
  const contentProbe = useWorkspaceContentProbe(onDashboard ? activeSlug : "");
  const { user } = useAuth();
  const tour = useTour(onDashboard && contentProbe.ready && !contentProbe.hasContent, user?.id ?? null);

  // Is the labels module on? Gates the label-queue foot row below. Shares the
  // cached ["org-modules"] query the nav already fetches — no extra request.
  const orgModulesQ = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const labelsEnabled = (orgModulesQ.data?.items ?? []).some((m) => m.name === "labels" && m.enabled);

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
  // Canary uses chrome: "mark" — real prod data, so it should READ as the
  // product: no tinted header, no chip, just a dot on the logo. Only banner
  // environments (fake data) get the loud treatment.
  const envBanner = envBadge?.chrome === "banner" ? envBadge : null;
  const envDot = envBadge?.chrome === "mark" ? envBadge.markDot : undefined;
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

  // "Completely sidebar" (Notion/Linear shape): nav in the sidebar AND the top
  // bar hidden — brand/workspace move to the sidebar head, the quick-action
  // cluster to its foot. Desktop-only; the mobile header always stays. A
  // managed app keeps its top bar (its chrome is deliberately minimal already).
  const fullSide = navMode === "side" && !navTopBar && !appMode;
  // DEV-chip toast tester: each click on the env chip fires
  // the next toast kind, so toast styling/placement is one click to eyeball.
  // Inherently non-prod: the chip only renders when envBadge exists.
  const toast = useToast();
  const demoIdx = useRef(0);
  const demoToast = () => {
    const demos: Array<() => void> = [
      () => toast.success("Success toast - saved, enabled, done."),
      () => toast.info("Info toast - importing 12 parts…"),
      () => toast.error("Error toast - couldn't reach the printer."),
      () => toast.action("Action toast - sticky until dismissed.", { actionLabel: "Do it", onAction: () => { toast.success("Did it."); } }),
    ];
    demos[demoIdx.current % demos.length]!();
    demoIdx.current++;
  };
  // Toasts land in the sidebar's EMPTY MIDDLE in full-sidebar mode (the author):
  // publish the mode + the live foot-cluster height as CSS hooks; index.css
  // repositions the (body-portaled) toast stack over the rail, stacking
  // upward from just above the action cluster. Persistent notices stay
  // sidebar-docked cards (the verify-email pattern); this is ephemeral only.
  const footRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = document.documentElement;
    if (!fullSide) return;
    el.dataset.navFullside = "1";
    const f = footRef.current;
    const update = () => el.style.setProperty("--cobblr-foot-h", `${f?.getBoundingClientRect().height ?? 0}px`);
    update();
    const ro = f ? new ResizeObserver(update) : null;
    if (f && ro) ro.observe(f);
    return () => {
      ro?.disconnect();
      delete el.dataset.navFullside;
      el.style.removeProperty("--cobblr-foot-h");
    };
  }, [fullSide, navAutoHide]);
  // The sidebar's own controls, top-right (the author): pin ⇄ auto-hide and the
  // top-bar toggle as two small icon buttons — the whole footer options row
  // they replace is gone.
  const sidebarControls = (
    <div className="flex items-center gap-0.5">
      {!skin && (
        <button
          type="button"
          onClick={toggleTheme}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          className="p-1 rounded text-faint dark:text-slate-500 hover:text-accent transition"
        >
          {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
        </button>
      )}
      <button
        type="button"
        onClick={flipAutoHide}
        title={navAutoHide ? "Auto-hiding — click to pin the sidebar open" : "Pinned — click to auto-hide the sidebar"}
        className="p-1 rounded text-faint dark:text-slate-500 hover:text-accent transition"
      >
        {navAutoHide ? <PinOff size={13} /> : <Pin size={13} />}
      </button>
      <button
        type="button"
        onClick={flipTopBar}
        title={navTopBar ? "Hide the top bar — everything moves into the sidebar" : "Show the top bar again"}
        className={"p-1 rounded transition " + (navTopBar ? "text-faint dark:text-slate-500 hover:text-accent" : "text-accent")}
      >
        <PanelTop size={13} />
      </button>
    </div>
  );
  const sidebarHead = fullSide ? (
    <div className="desktop-titlebar-pad shrink-0 border-b border-line dark:border-slate-800 px-3 py-2.5 space-y-2 overflow-hidden">
      <div className="flex items-center gap-2 min-w-0">
        {/* The brand row is the wordmark + controls ONLY. The env chip lives on
            the workspace row below, so no badge (Staging/Dev/Test, any label
            length) can crowd "cobblr" down to "co..." — reported 2026-07-29. */}
        <Link to="/" className="flex items-center gap-1.5 min-w-0 shrink-0 hover:opacity-80 transition">
          <CobblestoneMark size={20} dot={envDot} />
          <span className="font-display font-extrabold text-content dark:text-mortar-100 lowercase text-[15px]">cobblr</span>
        </Link>
        <span className="flex-1" />
        <span className="shrink-0">{sidebarControls}</span>
      </div>
      <div className="relative flex items-center gap-1.5 min-w-0">
        {wsLogo && <img src={wsLogo} alt="" className="w-5 h-5 rounded object-contain shrink-0 border border-line dark:border-slate-700" />}
        {/* z-10 so the inline workspace dropdown (which ACCORDIONS full-width
            under this row) renders OVER the env chip below. */}
        <div data-tour="workspace" className="relative z-10 min-w-0 flex-1">
          {/* inline → the workspace list ACCORDIONS under this row (no
              floating popover in the sidebar — the author's rule). */}
          <WorkspaceSwitcher inline />
        </div>
        {/* Env chip: absolute + anchored to the TOP of this row (not a flex
            sibling), so it neither steals width from the switcher nor floats to
            the vertical middle when the list expands. It sits to the right of the
            collapsed trigger; the full-width dropdown covers it when open. reported 2026-07-29 (a flex-sibling chip narrowed the dropdown + floated it). */}
        {envBanner && (
          <button
            type="button"
            onClick={demoToast}
            title="Fire a sample toast (dev chip tradition)"
            className={`absolute right-0 top-2 z-0 rounded px-1 py-0.5 text-[9px] font-mono font-bold uppercase tracking-widest ${envBanner.chip}`}
          >
            {envBanner.label}
          </button>
        )}
      </div>
    </div>
  ) : undefined;
  const sidebarFoot = fullSide ? (
    <div ref={footRef} className="shrink-0 border-t-2 border-line dark:border-slate-700 px-1.5 py-1.5 flex flex-col">
      {/* The verify-email nudge docks here (sidebar card) — not as a thin bar
          over the content. The simple-mode exit sits in the same slot (permanent
          while simple mode is on — the always-visible way to turn it off). */}
      <SimpleModeNotice variant="sidebar" />
      <EmailVerifyBanner variant="sidebar" />
      {/* Feedback sits in the "notices" realm (with verify-email) — it's a meta
          "reach the makers" nudge, not a workspace tool, so it heads the foot as
          its own tiny section, divided from the tools below. The floating pill is
          suppressed in full-sidebar (App.tsx). */}
      <FeedbackWidget asRow />
      <div className="my-1 border-t border-line dark:border-slate-700" />
      {/* Module quick-actions (Build/Scan) SHARE one row — half-width each,
          wrapping if a third ever appears. */}
      <div data-tour="actions" className="flex flex-wrap gap-0.5 [&_a]:flex-1 [&_a]:min-w-[45%] [&_a]:px-3 [&_a]:py-1.5 [&_a]:rounded [&_a]:text-[13px] [&_a]:gap-2.5">
        <HeaderActions />
      </div>
      {/* Search opens the ⌘K palette — a centered overlay beats an expanding
          input + popover crammed into a 208px column. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
        title="Search (⌘K)"
        aria-label="Search"
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition"
      >
        <Search size={16} className="shrink-0" />
        Search
      </button>
      <NotificationsBell panelOnly asRow />
      {/* Label-queue lives as a foot row here (not a floating pill) so it reads
          as workspace chrome with its neighbours; renders nothing when the
          queue is empty. The floating pill is suppressed in full-sidebar
          (App.tsx). */}
      {labelsEnabled && <LabelsBasket asRow orgSlug={activeSlug} getToken={getToken} />}
      {/* Live box — ongoing session modes (auto-print, …), tucked at the foot.
          Self-hides when the workspace has no applicable live capability. */}
      <LiveBox mode="sidebar" slug={activeSlug} />
      <ChatLauncher open={chatOpen} setOpen={setChatOpen} asRow />
      {/* Configuration lives HERE, not behind the account flyout — the flyout
          detour (open menu → Configuration → back into the sidebar) was the
          exact loop the author flagged. */}
      {/* Profile is a first-class row (the author) — the account row below keeps
          only the menu (feedback / what's new / sign out). */}
      <NavLink
        to="/me"
        className={({ isActive }) =>
          "w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] transition " +
          (isActive
            ? "text-accent font-semibold bg-subtle/60 dark:bg-slate-800/40"
            : "text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40")
        }
      >
        <UserRound size={16} className="shrink-0" />
        Profile
      </NavLink>
      {!isFocused(activeOrg) && (
        <NavLink
          to="/configuration"
          className={({ isActive }) =>
            "w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] transition " +
            (isActive
              ? "text-accent font-semibold bg-subtle/60 dark:bg-slate-800/40"
              : "text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40")
          }
        >
          <Sliders size={16} className="shrink-0" />
          Configuration
        </NavLink>
      )}
      {/* Account expands UPWARD in place — an accordion, not a popover. */}
      <UserMenu themed={!!skin} inline />
    </div>
  ) : undefined;

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
    <DriveProvider>
    {/* Only renders inside the desktop app, where the window has no title bar
        left to grab. A PINNED sidebar is sticky, so the band over it stays live
        while scrolled; everywhere else the band must yield once content can
        pass beneath it. */}
    <DesktopDragStrip pinned={navMode === "side" && !navAutoHide} topBar={!fullSide} />
    {tour.open && <GuidedTour steps={DASHBOARD_TOUR} onClose={tour.close} />}
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
        ref={headerRef}
        className={`${fullSide ? "md:hidden md:static " : ""}fixed inset-x-0 top-0 z-30 border-b backdrop-blur overflow-x-clip max-md:transition-transform max-md:duration-200 motion-reduce:transition-none ${
          barHidden ? "max-md:-translate-y-full" : ""
        } ${envBanner ? envBanner.header : DEFAULT_HEADER}`}
        // paddingTop: the iOS status-bar safe area. In standalone (home-screen)
        // mode the webview is full-bleed, and without this the workspace name
        // renders UNDER the status-bar clock. env() is 0 in a normal browser
        // tab, so nothing changes there. e2e/mobile-overflow.mjs asserts it.
        style={{
          paddingTop: "env(safe-area-inset-top)",
          ...(skin ? { borderTop: "4px solid var(--app-accent)" } : {}),
        }}
      >
        {/* Header chrome spans the FULL window (no max-width cap) so the module
            nav gets the whole row; page content below stays centred at max-w-6xl. */}
        {/* py-2 on a phone, py-3 from md up.
            On a phone this row IS the whole navigation bar, and every point it
            spends comes out of the list underneath it. 8px around a ~28px row
            lands on ~44px — the height iOS uses for a toolbar — and still leaves
            the wordmark clear of the status bar.

            Deliberately UNEVEN on a phone (pt-1 pb-2): the row rides high in
            the bar so it sits as close to the top of the screen as it can, which
            is the whole point of the bar there. Evening it out is the obvious
            tidy-up and would undo this.

            It reads the same in all three shells, which is the point. In the PWA
            and in a notched browser the webview is edge-to-edge, so
            `env(safe-area-inset-top)` on the header supplies the inset; in the
            native app iOS insets the WEBVIEW and env() is 0. Different routes,
            same final position, so this padding is the only knob and turning it
            moves all three together. */}
        <div className="desktop-topnav-pad px-5 pt-1 pb-2 md:py-3 flex items-center gap-2 sm:gap-3 min-w-0">
          {/* Nav-placement flip (desktop): top bar ⇄ left sidebar. Sits LEFT
              of the wordmark, à la Vivaldi's panel toggle. Icon shows the
              layout you'd switch TO. */}
          <button
            type="button"
            onClick={flipNavMode}
            title={navMode === "top" ? "Move navigation to a left sidebar" : "Move navigation back to the top bar"}
            aria-label={navMode === "top" ? "Switch to sidebar navigation" : "Switch to top navigation"}
            className="hidden md:inline-flex shrink-0 p-1 rounded text-faint dark:text-slate-500 hover:text-accent transition"
          >
            {navMode === "top" ? <PanelLeft size={15} /> : <PanelTop size={15} />}
          </button>
          {/* Brand. On mobile the distinctive mark alone carries it and the
              "cobblr" wordmark is dropped, so the WORKSPACE NAME (the real context)
              gets that ~100px instead of truncating. Desktop keeps the full mark +
              wordmark. */}
          <Link
            to="/"
            className="relative flex items-center gap-2 shrink-0 hover:opacity-80 transition"
          >
            <CobblestoneMark size={26} dot={envDot} />
            <span className="hidden sm:inline font-display font-extrabold text-content dark:text-mortar-100 lowercase">
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
            {envBanner && (
              <span
                className={`sm:hidden absolute right-0 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 text-[9px] font-mono font-bold uppercase tracking-widest ${envBanner.chip}`}
              >
                {envBanner.label}
              </span>
            )}
          </Link>
          {/* Desktop: the chip sits inline beside the wordmark (room to spare). */}
          {envBanner && (
            <button
              type="button"
              onClick={demoToast}
              className={`hidden sm:inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-widest ${envBanner.chip}`}
              title={`You are on the ${envBanner.label} environment — not production. Click: fire a sample toast.`}
            >
              {envBanner.label}
            </button>
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
              <div data-tour="workspace" className="min-w-0">
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
          {navMode === "top" ? (
            <nav data-tour="nav" className="hidden md:flex flex-nowrap items-center gap-0.5 flex-1 min-w-0">
              <ModuleNav />
            </nav>
          ) : (
            <div className="hidden md:block flex-1 min-w-0" />
          )}

          {/* Right cluster (desktop) — never shrinks. The cryptic icon
              row (super-admin / calendar / configuration / profile /
              theme / sign-out) is folded into UserMenu; scan, search +
              notifications stay as their own affordances. */}
          <div data-tour="actions" className="hidden md:flex items-center gap-1 shrink-0">
            {/* Module-contributed critical quick-actions (e.g. scan). */}
            <HeaderActions />
            <SearchBar />
            <NotificationsBell />
            {/* Ask-Cobblr launcher — a header button, not a floating FAB. */}
            <ChatLauncher open={chatOpen} setOpen={setChatOpen} />
            <UserMenu themed={!!skin} />
          </div>

          {/* Mobile: spacer pushes the right cluster to the edge. The scan
              quick-action + AI launcher live here too (were desktop-only) so
              the phone navbar has the buttons, not just the hamburger. */}
          <div className="flex-1 md:hidden" />
          <div className="shrink-0 md:hidden flex items-center gap-0.5">
            <HeaderActions />
            <ChatLauncher open={chatOpen} setOpen={setChatOpen} />
            <MobileNav />
          </div>
        </div>
      </header>
      {/* Holds the fixed bar's place on mobile, so the banners and the page do
          not start underneath it. Its height is MEASURED rather than assumed —
          the bar grows with the env chip, a skin's accent edge and the status-bar
          inset. Desktop needs none: the header is `md:static` and still in flow.
          It keeps its height while the bar is hidden, on purpose — reserving the
          space means an upward flick reveals the bar over the page instead of
          shoving the content down under your thumb. */}
      <div className={fullSide ? "md:hidden" : ""} aria-hidden style={{ height: barH }} />
      {/* THE chat panel — one mount for however many launchers the chrome has.
          It portals to <body>, so where it sits here is bookkeeping, but that it
          appears exactly once is not: a second mount is a second conversation
          stacked over the first (ChatWidget.test.ts pins this). */}
      <ChatPanel open={chatOpen} setOpen={setChatOpen} />

        {!fullSide && <SimpleModeNotice />}
        {!fullSide && <EmailVerifyBanner />}
      </div>

      {/* Modals center within the CONTENT area: publish the reserved edges
          (pinned sidebar left, chat panel right) for platform-web's Modal.
          Auto-hide mode reserves nothing — the panel overlays content. */}
      <PublishModalInsets left={navMode === "side" && !navAutoHide ? "14rem" : "0px"} right={chatOpen ? "456px" : "0px"} />
      {/* When the Ask-Cobblr panel (fixed 440px right sidebar) is open, reserve
          its width on wide screens so the centered content shifts LEFT into its
          margin and the two coexist — no overlap, no compression (xl+ has room). */}
      <div className="min-w-0 flex items-stretch">
        {/* Pinned sidebar: an in-flow skinny column. Sticks to the viewport
            top as the page scrolls (the header itself scrolls away), owns its
            own scrollbar when the nav outgrows the screen. Desktop-only —
            mobile keeps the hamburger regardless of mode. */}
        {navMode === "side" && !navAutoHide && (
          <aside className="hidden md:block w-56 shrink-0 border-r border-line dark:border-slate-800 bg-surface/60 dark:bg-slate-900/60">
            {/* The sticky inner wrapper caps at the viewport (max-h-dvh) and
                scrolls internally, so it works under ANY header height —
                banners included — without measuring anything. */}
            <div className={"sticky top-0 flex flex-col overflow-hidden " + (fullSide ? "h-dvh" : "max-h-dvh")}>
              <SidebarNav head={sidebarHead} foot={sidebarFoot} controls={sidebarControls} />
            </div>
          </aside>
        )}
        {/* Auto-hiding sidebar: a 10px hover strip on the window's left edge
            slides the panel over the content (Vivaldi's auto-hide) — the page
            keeps its full width until you reach for it. */}
        {/* pointer-events-none on the container: its layout box is the full
            panel width even while the panel is translated off-screen, and it
            must never eat clicks meant for the header/content beneath it.
            The strip + panel re-enable their own pointer events. */}
        {navMode === "side" && navAutoHide && (
          <div className="hidden md:block fixed bottom-0 left-0 z-40 group/snav pointer-events-none" style={{ top: hideTop }}>
            <div className="pointer-events-auto absolute inset-y-0 left-0 w-2.5 border-l-2 border-line dark:border-slate-700 group-hover/snav:border-accent transition" />
            <aside className="pointer-events-auto h-full w-56 flex flex-col overflow-hidden -translate-x-full group-hover/snav:translate-x-0 focus-within:translate-x-0 transition-transform duration-150 border-r border-line dark:border-slate-700 bg-surface dark:bg-slate-900 group-hover/snav:shadow-xl focus-within:shadow-xl">
              <SidebarNav head={sidebarHead} foot={sidebarFoot} controls={sidebarControls} />
            </aside>
          </div>
        )}
      <main className={`flex-1 min-w-0 transition-[padding] duration-200 ${chatOpen ? "xl:pr-[456px]" : ""}`}>
        {/* pb clears the mobile bottom action bar; md+ has no bar. */}
        <div className="max-w-6xl mx-auto w-full px-5 py-6 pb-20 md:pb-6">
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
      {/* App-wide hardware-scanner intake: a physical barcode scan registers
          from any screen (off the Scan tab) and always toasts — no silent drop.
          Stands down on the Scan page, which owns the wedge there. */}
      {activeSlug ? <GlobalScanWedge activeSlug={activeSlug} /> : null}
      {/* Quick Access — pinned Knowledge Base entries, one tap from any page
          (renders only when the knowledge module is enabled). */}
      {activeSlug ? <QuickAccess activeSlug={activeSlug} /> : null}
      {/* ⌘K — do or find anything (redesign B4). */}
      <CommandPalette />
      {/* Stale-tab nudge: deploys are frequent; open tabs must find out. */}
      <NewVersionNudge />
      {/* Feature 3 folds into the Live box now: the drive prompt + indicator are
          rendered by LiveBox; DriveProvider (wrapping the shell) is the headless
          SSE transport + presence overlay. Floating mount for non-full-sidebar
          layouts (mobile / top-bar); full-sidebar uses the sidebar-foot mount. */}
      {!fullSide && activeSlug && <LiveBox mode="floating" slug={activeSlug} />}
    </div>
    </DriveProvider>
  );
}


/** Publish the shell's reserved edges as CSS vars on <html> so overlays
 *  (platform-web Modal) can center within the content area. */
function PublishModalInsets({ left, right }: { left: string; right: string }) {
  useEffect(() => {
    const el = document.documentElement;
    el.style.setProperty("--modal-inset-left", left);
    el.style.setProperty("--modal-inset-right", right);
    return () => {
      el.style.removeProperty("--modal-inset-left");
      el.style.removeProperty("--modal-inset-right");
    };
  }, [left, right]);
  return null;
}
