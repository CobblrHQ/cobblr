// Mobile navigation. On narrow screens the desktop ModuleNav's
// horizontal link strip is unusable (links scroll out of view with
// no affordance). This renders a hamburger button + a full-width
// dropdown panel carrying every nav destination: dashboard, module
// links + their specialisations, profile, configuration, theme,
// sign-out. The panel is full-height (a sticky header + a scrolling
// body) — the desktop UserMenu that owns Profile is desktop-only, so
// this is the only place a mobile user reaches their account.
//
// The panel is portaled to document.body with fixed positioning —
// the header uses backdrop-blur, which traps position:fixed
// descendants, so an in-header panel would be clipped. Same trick
// the ModuleNav popover uses.

import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavPointer } from "../lib/navPointer";
import { createPortal } from "react-dom";
import { dismissOnEmptySpace } from "../lib/dismiss-on-empty";
import { MoreAppsDoor } from "./MoreAppsDoor";
import { NavLink } from "react-router-dom";
import { Menu, X, Moon, Sun, LogOut, Sliders, UserCog, Bell } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { LabelsBasket } from "./LabelsBasketLazy";
import { api, getToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { configurationReachable } from "../lib/configuration-nav";
import { UpdateBadge } from "./UpdateBadge";
import { usePendingAiShares } from "../lib/usePendingAiShares";
import { useAuth } from "../auth/AuthContext";
import { COMMUNITY_HEADING, CommunityLinks } from "./CommunityLinks";
import { useTheme } from "../theme/ThemeContext";
import { useNavHasRow, useNavModules, HEADING_PREFIX, INSTANCE_PREFIX, NAVGROUP_PREFIX, navTargetFor, stripNavStem, surfaceTops } from "./useNavModules";
import { groupNavRows, isNavTool } from "./nav-groups";
import { phoneMenuSections } from "./phone-menu";
import { useNavBadges } from "./useNavBadges";
import { NavCountBadge } from "./NavCountBadge";
import { NavRowMenu, type RowCollection } from "./NavSplitRow";
import { CobblestoneMark } from "../CobblestoneMark";
import { OverlayLayer, useEscapeToClose, useLockPageScroll } from "@cobblr/platform-web";
import { notificationKeys } from "../lib/notification-keys";

export function MobileNav() {
  const { activeOrg, activeSlug } = useActiveOrg();
  const { tops, childrenByParent, instanceGroups, doorNames, placement } = useNavModules(activeSlug);
  // A locked managed app ("Cobblr for Yarn") shows ONLY its own surface. The
  // desktop nav already hid the platform rows; this menu did not, so a knitter
  // on a phone saw Dashboard, Calendar and Configuration and every tap bounced
  // back to the yarn table. Same predicate the route guard uses, so the two
  // cannot disagree about what is inside the app.
  const appMode = !!activeOrg?.app_mode;
  const visibleTops = surfaceTops(tops, appMode);
  const rowCandidates = visibleTops.flatMap((t) => instanceGroups.get(t.name)?.members ?? (t.name.startsWith("__instance__") ? [t] : []));
  const badges = useNavBadges(activeSlug);
  const pendingShares = usePendingAiShares(activeSlug, activeOrg?.role === "owner");
  const { logout, user } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  // The "…" on a row (split, join) is for rearranging, not for every visit:
  // it shows in Arrange, switched on in the menu's header or by holding a row.
  const [arranging, setArranging] = useState(false);
  const hold = useLongPress(() => setArranging(true));
  // A table the person just got, pointed at once (navPointer.ts): a dot on the
  // closed menu button, then "New" beside it in the open menu.
  const pointer = useNavPointer(activeSlug);
  const [pointed, setPointed] = useState<string | null>(null);

  // Unread notifications, cross-workspace — shares the header bell's query key
  // so the two stay in sync. The desktop bell polls this every 15s but is
  // desktop-only; on mobile this hook is the sole owner, so it polls too.
  const unread = useQuery({
    queryKey: notificationKeys.unread(),
    queryFn: () => api.meNotificationsUnreadCount(),
    refetchInterval: 30000,
  });
  const unreadCount = unread.data?.count ?? 0;

  // Is the labels module on? Gates the label-queue row below (the floating pill
  // is desktop-only now — see BasketWidget). Shares the cached ["org-modules"]
  // query the nav already fetches — no extra request.
  const orgModulesQ = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const labelsEnabled = (orgModulesQ.data?.items ?? []).some((m) => m.name === "labels" && m.enabled);
  const labelsHasRow = useNavHasRow(activeSlug, "labels");

  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(open, panelRef, () => setOpen(false));

  // Lock body scroll while the panel is open.
  useLockPageScroll(open);

  const linkClass =
    "flex min-h-11 h-full min-w-0 items-center gap-2 px-3 text-sm whitespace-nowrap " +
    "text-content dark:text-mortar-100 active:bg-subtle dark:active:bg-slate-800 transition";
  const standaloneLinkClass = linkClass + " border-b border-line dark:border-slate-800";
  const headerClass = "flex min-h-11 h-full items-end gap-2 bg-subtle/60 px-3 pb-1.5 pt-4 uppercase text-[10px] font-mono tracking-widest text-faint dark:bg-slate-800/40 dark:text-slate-500";
  const close = () => setOpen(false);
  const arrangeMenu = (label: string, members: RowCollection[]) =>
    arranging ? <NavRowMenu slug={activeSlug} label={label} members={members} candidates={rowCandidates} className="flex w-11 self-stretch items-center justify-center normal-case tracking-normal" /> : null;
  const row = (key: string, to: string, label: string, extra?: ReactNode, end?: ReactNode): MenuEntry => ({ key, content: (
    <div className="flex h-full min-w-0 items-stretch">
      <NavLink to={to} end={to === "/"} className={linkClass + " flex-1"} onClick={close}>
        <span>{label}</span>
        {extra}
        <NavCountBadge count={badges.get(key)} label={label} className="ml-auto" />
      </NavLink>
      {end}
    </div>
  ) });
  const header = (key: string, label: string, door?: string | null, end?: ReactNode): MenuEntry => ({ key, fullWidth: true, header: true, content: (
    <div className="flex h-full items-stretch">
      {door
        ? <NavLink to={door} onClick={close} className={headerClass + " flex-1 hover:text-accent"}>{label}</NavLink>
        : <div role="heading" aria-level={3} className={headerClass + " flex-1"}>{label}</div>}
      {end && <div className="flex items-stretch bg-subtle/60 dark:bg-slate-800/40">{end}</div>}
    </div>
  ) });
  const entries: MenuEntry[] = [];
  if (!appMode) {
    entries.push(row("home", "/", "Home"));
    entries.push(row("search", "/search", "Search"));
  }
  const isBlock = (t: { name: string }) => t.name.startsWith(NAVGROUP_PREFIX) || t.name.startsWith(HEADING_PREFIX) || (childrenByParent.get(t.name)?.length ?? 0) > 0;
  const sections = phoneMenuSections(visibleTops, {
    isBlock,
    isTool: (t) => isNavTool(t, doorNames, placement),
    grouped: groupNavRows(visibleTops, doorNames, { homeRow: !appMode, placement }).grouped,
  });
  const loose = (m: (typeof visibleTops)[number]) => row(m.name, navTargetFor(m.name, appMode), m.displayName,
    pointed === m.displayName ? <NewInNav /> : undefined,
    m.name.startsWith(INSTANCE_PREFIX) ? arrangeMenu(m.displayName, [m]) : undefined);
  const block = (m: (typeof visibleTops)[number]) => {
    const group = m.name.startsWith(NAVGROUP_PREFIX) ? instanceGroups.get(m.name) : undefined;
    if (group) {
      // A bundle's group (LEGO: Sets, Bricks): its label is the header and each
      // member an ordinary row, never two links squeezed into one cell.
      entries.push(header(m.name, group.label || "Collections", null, arrangeMenu(group.label || "Collections", group.members)));
      for (const mem of group.members) {
        // Under its header a row drops the group's word ("Filament vendors" → "Vendors"), and starts with a capital like every other row.
        const label = stripNavStem(mem.displayName, group.label);
        entries.push(row(mem.name, navTargetFor(mem.name, appMode), label.charAt(0).toUpperCase() + label.slice(1)));
      }
      return;
    }
    const isHeading = m.name.startsWith(HEADING_PREFIX);
    entries.push(header(m.name, m.displayName, isHeading ? null : navTargetFor(m.name, appMode)));
    for (const k of childrenByParent.get(m.name) ?? []) {
      const isInstance = k.name.startsWith(INSTANCE_PREFIX);
      const to = isInstance ? navTargetFor(k.name, appMode) : isHeading ? `/${k.name}` : `/${m.name}?lens=${k.name}`;
      entries.push(row(k.name, to, k.displayName, !isInstance && !isHeading ? <span className="shrink-0 text-[10px] font-mono text-faint">lens</span> : undefined));
    }
  };
  for (const s of sections) {
    for (const m of s.blocks) block(m);
    if (s.looseTitle) entries.push(header(`section:${s.looseTitle}`, s.looseTitle));
    for (const m of s.loose) entries.push(loose(m));
  }
  if (!appMode) entries.push({ key: "more-apps", fullWidth: true, content: <MoreAppsDoor plain onNavigate={close} className={linkClass} /> });
  // One cell of the pinned account footer. min-w-0 + flex-1 so five of them
  // share a 393px phone evenly without any one pushing the row wide.
  const footItem =
    "flex-1 min-w-0 flex flex-col items-center justify-center gap-1 rounded-md py-1 " +
    "text-content dark:text-mortar-100 active:bg-subtle dark:active:bg-slate-800 transition";
  const footLabel = "text-[10px] leading-none text-muted dark:text-slate-400";

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!open && pointer.label) {
            setPointed(pointer.label);
            pointer.seen();
          }
          setOpen((o) => !o);
        }}
        title={open ? "Close menu" : "Open menu"}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        data-tour="menu"
        className="md:hidden relative text-muted dark:text-slate-400 hover:text-accent transition p-1.5"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
        {/* Attention signal, visible without opening the menu. Unread
            notifications (red) take precedence over the bundle-updates dot —
            they're more time-sensitive, and there's only room for one dot. */}
        {!open && pointer.label && unreadCount === 0 && (
          <span data-testid="nav-pointer-dot" className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-cobble-600 ring-2 ring-surface dark:ring-slate-900 animate-pulse" />
        )}
        {!open && !(pointer.label && unreadCount === 0) &&
          (unreadCount > 0 ? (
            <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-ember-500 ring-2 ring-surface dark:ring-slate-900" />
          ) : (
            <span className="absolute top-0.5 right-0.5">
              <UpdateBadge slug={activeSlug} variant="dot" />
            </span>
          ))}
      </button>

      {open &&
        createPortal(
          <OverlayLayer ref={panelRef} className="md:hidden z-[80]" role="dialog" aria-modal="true" aria-label="Menu">
            {/* No backdrop: the panel below is `absolute inset-0` and opaque, so
                anything behind it is invisible AND unreachable. One used to sit
                here claiming "tap to dismiss", which was never true and is the
                reason the dead space went unnoticed for so long: the code said
                the gesture existed. Dismissing by tapping nothing is handled
                inside the panel, where the empty space actually is. */}
            {/* panel — full height so page content never peeks below it; the
                header pins while the destinations scroll under it. */}
            <nav
              className="absolute inset-0 bg-surface dark:bg-slate-900 shadow-lg flex flex-col"
              aria-label="Main navigation"
            >
              {/* paddingTop: the iOS status-bar safe area, the same inset the
                  page header carries. This panel is `fixed inset-0`, so it
                  covers the whole screen INCLUDING the status bar — without it
                  the wordmark renders under the clock. Only visible in a
                  full-bleed shell (the native app, or standalone home-screen
                  mode); env() is 0 in a normal browser tab. */}
              {/* Geometry copied from the app header's own row, so opening the
                  menu does not nudge the brand: `px-5 pt-1 pb-2`, the mark at
                  26px, `gap-2` after it. Those are the header's values (see
                  AppLayout's nav row) and they have to stay in step - the mark
                  sits at the same x and the row is the same height, so the
                  wordmark and the close button land exactly where the bar's
                  contents were. The uneven pt-1/pb-2 is deliberate there and is
                  kept here for the same reason: the row rides high in the bar. */}
              <div
                className="shrink-0 flex items-center justify-between px-5 pt-1 pb-2 border-b border-line dark:border-slate-800"
                style={{ paddingTop: "calc(0.25rem + env(safe-area-inset-top))" }}
              >
                {/* The mark carries over from the bar. The bar drops the
                    "Cobblr" wordmark on a phone to give the workspace name that
                    width; in here there is nothing competing for the row, so
                    both fit. */}
                <span className="flex items-center gap-2 min-w-0">
                  <CobblestoneMark size={26} />
                  <span className="font-display font-extrabold text-content dark:text-mortar-100">
                    Cobblr
                  </span>
                </span>
                <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-pressed={arranging}
                  onClick={() => setArranging((a) => !a)}
                  data-testid="menu-arrange"
                  className={"min-h-11 rounded px-2 text-xs transition " + (arranging ? "font-medium text-accent" : "text-muted hover:text-accent dark:text-slate-400")}
                >
                  {arranging ? "Done" : "Arrange"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="Close menu"
                  aria-label="Close menu"
                  className="text-faint hover:text-accent transition p-1"
                >
                  <X size={18} />
                </button>
                </span>
              </div>

              {/* The slack below the last destination is empty space, and a tap
                  there means "put this away". This panel covers the whole
                  screen, so there is no backdrop to reach for. */}
              <div
                className="flex-1 overflow-y-auto"
                onClick={dismissOnEmptySpace(() => setOpen(false))}
              >
              <div {...hold}><MenuGrid entries={entries} /></div>

              {/* The label queue's count rides on the Labels row as a badge
                  (nav.count). This row is for a person who took Labels out of
                  their menu, where it is the only sign anything is queued; with
                  the row there it would list Labels twice (#4374). Self-hides
                  when nothing is queued. */}
              {labelsEnabled && !appMode && !labelsHasRow && (
                <LabelsBasket
                  orgSlug={activeSlug}
                  getToken={getToken}
                  asRow
                  rowClassName={standaloneLinkClass}
                  onNavigate={() => setOpen(false)}
                />
              )}

              {/* The community, at the end of the list: the phone's only door
                  to it (the account menu that carries it is desktop-only). The
                  same component every menu uses, so it is here exactly when the
                  deployment offers it. Not in a managed app, whose menu leads
                  nowhere outside the app. */}
              {!appMode && (
                <CommunityLinks
                  user={user}
                  itemClassName={standaloneLinkClass}
                  onNavigate={() => setOpen(false)}
                  heading={<div className="mt-2 px-4 pt-2 border-t border-line dark:border-slate-800 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">{COMMUNITY_HEADING}</div>}
                />
              )}

              </div>

              {/* The ACCOUNT rows are a PINNED footer, outside the scrolling
                  region above.
                  As five full-width rows they cost five rows however long the
                  destination list was, and they moved with it: measured against
                  this panel, at 24 destinations "sign out" fell off the bottom
                  of an iPhone 14 Pro, and this workspace already has 19. The
                  alternative considered was a block in the bottom-right of the
                  flow, which reads better but has the same failure - a block
                  that destinations can flow around must be IN the flow, and
                  anything in the flow scrolls away. Pinned, the list length
                  cannot reach it at any count.
                  Options weighed, and the one worth revisiting (a pinned card
                  rather than a bar), are written up in
                  docs/design-decisions/mobile-menu-account-block.md. */}
              {/* paddingBottom: the iOS home-indicator inset. This panel is
                  `fixed inset-0`, so a footer pinned to its bottom edge sits
                  UNDER the home stripe and inside the screen's corner radius -
                  "sign out" ended up in the gesture area (reported 2026-08-11).
                  env() is 0 in a normal browser tab, so nothing changes there;
                  the mirror of the safe-area-inset-top the header already
                  carries. */}
              <div
                className="shrink-0 flex items-stretch justify-around border-t-2 border-line dark:border-slate-800 bg-subtle/60 dark:bg-slate-800/40 px-1 pt-2"
                style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
              >
                <NavLink
                  to="/me/notifications"
                  onClick={() => setOpen(false)}
                  className={footItem}
                  aria-label={unreadCount > 0 ? `notifications, ${unreadCount} unread` : "notifications"}
                >
                  <span className="relative">
                    <Bell size={18} />
                    {unreadCount > 0 && (
                      <span className="absolute -top-1.5 -right-2 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-ember-500 text-white text-[10px] font-semibold">
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </span>
                    )}
                  </span>
                  <span className={footLabel}>alerts</span>
                </NavLink>

                <NavLink to="/me" onClick={() => setOpen(false)} className={footItem}>
                  <UserCog size={18} />
                  <span className={footLabel}>account</span>
                </NavLink>

{!appMode && configurationReachable(activeOrg?.role) && (
                <NavLink to="/configuration" onClick={() => setOpen(false)} className={footItem}>
                  {/* Signals ride ON the icon here, since a narrow footer cell
                      has no right edge to align them against. */}
                  <span className="relative">
                    <Sliders size={18} />
                    {pendingShares.length > 0 && (
                      <span
                        className="absolute -top-1 -right-1.5 h-2 w-2 rounded-full bg-amber-500"
                        title="A shared AI is waiting for your approval"
                      />
                    )}
                    <span className="absolute -top-2 -right-3">
                      <UpdateBadge slug={activeSlug} variant="count" />
                    </span>
                  </span>
                  <span className={footLabel}>config</span>
                </NavLink>
                )}

                {/* Stays OPEN. Every other control here goes somewhere, so
                    closing after it is what you want; this one changes the menu
                    you are looking at, and shutting it meant reopening to see
                    the result or to change your mind (reported 2026-08-11). */}
                <button type="button" onClick={() => toggle()} className={footItem}>
                  {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                  <span className={footLabel}>{theme === "dark" ? "light" : "dark"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    logout();
                  }}
                  className={footItem + " text-ember-500 dark:text-ember-500"}
                >
                  <LogOut size={18} />
                  <span className={footLabel}>sign out</span>
                </button>
              </div>
            </nav>
          </OverlayLayer>,
          document.body,
        )}
    </>
  );
}

/** "New": the table the person just got, beside its entry, once. */
function NewInNav() {
  return (
    <span data-testid="nav-new" className="shrink-0 rounded-full bg-cobble-600 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
      New
    </span>
  );
}

type MenuEntry = { key: string; content: ReactNode; fullWidth?: boolean; header?: boolean };

/** Holding a row switches Arrange on, the phone's way to a row's "…". The
 *  press that did it does not also open the row. */
function useLongPress(onHold: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const clear = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => clear, []);
  return {
    onPointerDown: () => {
      held.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        held.current = true;
        onHold();
      }, 500);
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      clear();
      held.current = true;
      onHold();
    },
    onClickCapture: (e: MouseEvent) => {
      if (!held.current) return;
      held.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/** Rows of one or two cells. A header starts a new row; two neighbours share
 *  a row only when both labels fit half the width, measured, so nothing is
 *  ever cut short with "…"; a row left with one cell takes the full width
 *  rather than leaving a hole. */
function MenuGrid({ entries }: { entries: MenuEntry[] }) {
  const grid = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState<ReadonlySet<string>>(new Set());
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A new width can fit a pair that did not fit before: measure from scratch.
  useLayoutEffect(() => setWide(new Set()), [width]);
  useLayoutEffect(() => {
    const over = [...(grid.current?.querySelectorAll<HTMLElement>("[data-menu-half]") ?? [])]
      .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
      .map((cell) => cell.dataset.menuHalf!)
      .filter((key) => !wide.has(key));
    if (over.length) setWide(new Set([...wide, ...over]));
  });
  const rows: MenuEntry[][] = [];
  let pair: MenuEntry[] = [];
  const flush = () => {
    if (pair.length) rows.push(pair);
    pair = [];
  };
  for (const entry of entries) {
    if (entry.fullWidth || wide.has(entry.key)) {
      flush();
      rows.push([entry]);
    } else {
      pair.push(entry);
      if (pair.length === 2) flush();
    }
  }
  flush();
  return <div ref={grid} data-testid="menu-grid" className="grid grid-cols-2">
    {rows.map((row) => <div key={row[0]!.key} data-menu-row={row[0]!.header ? "header" : ""} className="col-span-2 grid grid-cols-subgrid border-b border-line dark:border-slate-800">
      {row.map((entry) => <div
        key={entry.key}
        data-testid={entry.key === "more-apps" ? "menu-more-apps" : undefined}
        data-menu-half={row.length === 2 ? entry.key : undefined}
        className={"min-h-11 min-w-0" + (row.length === 1 ? " col-span-2" : " overflow-hidden")}
      >
        {entry.content}
      </div>)}
    </div>)}
  </div>;
}
