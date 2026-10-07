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

import { type ReactNode, useRef, useState } from "react";
import { useNavPointer } from "../lib/navPointer";
import { createPortal } from "react-dom";
import { dismissOnEmptySpace } from "../lib/dismiss-on-empty";
import { MoreAppsDoor } from "./MoreAppsDoor";
import { NavLink, useNavigate } from "react-router-dom";
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
import { useNavHasRow, useNavModules, NAVGROUP_PREFIX, navTargetFor, surfaceTops } from "./useNavModules";
import { useNavBadges } from "./useNavBadges";
import { NavCountBadge } from "./NavCountBadge";
import { NavSplitRow, NavRowMenu } from "./NavSplitRow";
import { CobblestoneMark } from "../CobblestoneMark";
import { OverlayLayer, useEscapeToClose, useLockPageScroll } from "@cobblr/platform-web";
import { notificationKeys } from "../lib/notification-keys";

/** The marker on a row that belongs to the group heading above it. It replaced
 *  the word "instance" on those rows: a dot under a heading already says
 *  "child of this", and the word was costing width that pushed longer names
 *  onto a second line. */
function ChildDot() {
  return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-moss-300 dark:bg-moss-200" />;
}

export function MobileNav() {
  const { activeOrg, activeSlug } = useActiveOrg();
  const { tops, childrenByParent, instanceGroups } = useNavModules(activeSlug);
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
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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

  function go(to: string) {
    navigate(to);
    setOpen(false);
  }

  const linkClass =
    "flex min-h-11 h-full min-w-0 items-center gap-2 px-3 text-sm " +
    "text-content dark:text-mortar-100 active:bg-subtle dark:active:bg-slate-800 transition";
  const standaloneLinkClass = linkClass + " border-b border-line dark:border-slate-800";
  const childClass = linkClass + " w-full text-left pl-6 text-muted dark:text-slate-400";
  const entries: MenuEntry[] = [];
  if (!appMode) {
    entries.push({ key: "home", content: <NavLink to="/" end className={linkClass} onClick={() => setOpen(false)}>Home</NavLink> });
    entries.push({ key: "search", content: <NavLink to="/search" className={linkClass} onClick={() => setOpen(false)}>Search</NavLink> });
  }
  for (const m of visibleTops) {
    if (m.name.startsWith(NAVGROUP_PREFIX)) {
      const group = instanceGroups.get(m.name);
      if (group) entries.push({ key: m.name, content: <NavSplitRow slug={activeSlug} group={group} candidates={rowCandidates} appMode={appMode} plain onNavigate={() => setOpen(false)} /> });
      continue;
    }
    const isHeading = m.name.startsWith("__heading__");
    entries.push({ key: m.name, fullWidth: isHeading, content: isHeading ? (
      <div className="flex min-h-11 h-full items-center px-3 text-faint dark:text-slate-500 uppercase text-[10px] font-mono tracking-widest">{m.displayName}</div>
    ) : (
      <div className="flex h-full min-w-0 items-stretch">
        <NavLink to={navTargetFor(m.name, appMode)} className={linkClass + " flex-1"} onClick={() => setOpen(false)}>
          <span className="truncate">{m.displayName}</span>
          {pointed === m.displayName && <NewInNav />}
          <NavCountBadge count={badges.get(m.name)} label={m.displayName} className="ml-auto" />
        </NavLink>
        {m.name.startsWith("__instance__") && <NavRowMenu slug={activeSlug} label={m.displayName} members={[m]} candidates={rowCandidates} className="flex w-7 items-center justify-center" />}
      </div>
    ) });
    for (const k of childrenByParent.get(m.name) ?? []) {
      const isInstance = k.name.startsWith("__instance__");
      const to = isInstance ? navTargetFor(k.name, appMode) : isHeading ? `/${k.name}` : `/${m.name}?lens=${k.name}`;
      entries.push({ key: k.name, content: <button type="button" onClick={() => go(to)} className={childClass}>
        <ChildDot />
        <span className="truncate">{k.displayName}</span>
        {!isInstance && !isHeading && <span className="shrink-0 text-[10px] font-mono text-faint">lens</span>}
      </button> });
    }
  }
  if (!appMode) entries.push({ key: "more-apps", fullWidth: true, content: <MoreAppsDoor plain onNavigate={() => setOpen(false)} className={linkClass} /> });
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
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="Close menu"
                  aria-label="Close menu"
                  className="text-faint hover:text-accent transition p-1"
                >
                  <X size={18} />
                </button>
              </div>

              {/* The slack below the last destination is empty space, and a tap
                  there means "put this away". This panel covers the whole
                  screen, so there is no backdrop to reach for. */}
              <div
                className="flex-1 overflow-y-auto"
                onClick={dismissOnEmptySpace(() => setOpen(false))}
              >
              <MenuGrid entries={entries} />

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

type MenuEntry = { key: string; content: ReactNode; fullWidth?: boolean };

function MenuGrid({ entries }: { entries: MenuEntry[] }) {
  const rows: MenuEntry[][] = [];
  let pair: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry.fullWidth) {
      if (pair.length) rows.push(pair);
      rows.push([entry]);
      pair = [];
    } else {
      pair.push(entry);
      if (pair.length === 2) { rows.push(pair); pair = []; }
    }
  }
  if (pair.length) rows.push(pair);
  return <div data-testid="menu-grid" className="grid grid-cols-2">
    {rows.map((row) => <div key={row[0]!.key} data-menu-row className="col-span-2 grid grid-cols-subgrid border-b border-line dark:border-slate-800">
      {row.map((entry) => <div key={entry.key} data-testid={entry.key === "more-apps" ? "menu-more-apps" : undefined} className={"min-h-11 min-w-0" + (entry.fullWidth ? " col-span-2" : "")}>
        {entry.content}
      </div>)}
      {row.length === 1 && !row[0]!.fullWidth && <div aria-hidden="true" className="min-h-11 min-w-0" />}
    </div>)}
  </div>;
}
