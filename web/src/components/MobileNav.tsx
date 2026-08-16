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

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { dismissOnEmptySpace } from "../lib/dismiss-on-empty";
import { NavLink, useNavigate } from "react-router-dom";
import { Menu, X, Moon, Sun, LogOut, Sliders, UserCog, Bell } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { LabelsBasket } from "@cobblr/labels/ui";
import { api, getToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { UpdateBadge } from "./UpdateBadge";
import { usePendingAiShares } from "../lib/usePendingAiShares";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { useNavModules, NAVGROUP_PREFIX, INSTANCE_PREFIX } from "./useNavModules";
import { CobblestoneMark } from "../CobblestoneMark";
import { OverlayFlag } from "@cobblr/platform-web";

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
  const pendingShares = usePendingAiShares(activeSlug, activeOrg?.role === "owner");
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // Unread notifications, cross-workspace — shares the header bell's query key
  // so the two stay in sync. The desktop bell polls this every 15s but is
  // desktop-only; on mobile this hook is the sole owner, so it polls too.
  const unread = useQuery({
    queryKey: ["me-notifications-unread"],
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

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Lock body scroll while the panel is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  function go(to: string) {
    navigate(to);
    setOpen(false);
  }

  // FIXED height + no wrapping. The two columns are independent flows, so their
  // rules only stay in step if every row is exactly the same height - and the
  // moment one label wrapped to a second line ("Digital Fabrication" once the
  // `instance` badge was taking width), everything below it in that column
  // slipped out of step with the other (reported 2026-08-11). A fixed height
  // with truncation makes that unrepresentable rather than merely fixed today:
  // no label, badge or future addition can push a row onto two lines.
  const linkClass =
    "flex h-11 items-center gap-2 px-4 text-sm border-b border-line dark:border-slate-800 " +
    "text-content dark:text-mortar-100 active:bg-subtle dark:active:bg-slate-800 transition";
  // A child of an instance group. The dot plus the group heading above it say
  // "belongs to Machines" on their own, which is why the rows no longer spell
  // out "instance" - the layout was already carrying it.
  const childClass =
    linkClass + " w-full text-left pl-7 text-muted dark:text-slate-400";
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
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        className="md:hidden relative text-muted dark:text-slate-400 hover:text-accent transition p-1.5"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
        {/* Attention signal, visible without opening the menu. Unread
            notifications (red) take precedence over the bundle-updates dot —
            they're more time-sensitive, and there's only room for one dot. */}
        {!open &&
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
          <div className="md:hidden fixed inset-0 z-[80]">
            <OverlayFlag />
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
                    "cobblr" wordmark on a phone to give the workspace name that
                    width; in here there is nothing competing for the row, so
                    both fit. */}
                <span className="flex items-center gap-2 min-w-0">
                  <CobblestoneMark size={26} />
                  <span className="font-display font-extrabold text-content dark:text-mortar-100 lowercase">
                    cobblr
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
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
              {/* TWO COLUMNS, for the destinations only.
                  A workspace with a normal number of modules ran this list past
                  the bottom of the screen: measured at 19 items it was 855px of
                  content, which overflows an iPhone 13 by 62px and an SE by
                  239px, so six destinations sat below the fold behind a scroll
                  nobody knows to do (reported 2026-08-11: "the mobile hamburger
                  nav goes off page, could do 2 cols if properly laid out").

                  CSS columns rather than a grid, because the list is not flat:
                  a parent and its indented lenses/instances are one <div>, and
                  `break-inside-avoid` keeps each of those groups whole inside a
                  single column. A grid would have split a parent from its
                  children across the gutter, which is the "properly laid out"
                  part of the ask.

                  The ACCOUNT rows below stay one column on purpose — they carry
                  ml-auto badges (unread count, update dots) that need the full
                  width to right-align against, and they are five fixed rows
                  rather than the part that grows. */}
              <div className="columns-2 gap-x-0 [&>*]:break-inside-avoid [&_a]:px-3 [&_button]:px-3 [&_.pl-8]:pl-6">
              <NavLink to="/" end className={linkClass} onClick={() => setOpen(false)}>
                dashboard
              </NavLink>

              {/* Search moved here when the bottom thumb-bar was removed — the
                  header search bar is desktop-only, so this is its only mobile
                  home. (Scan already has a header camera icon + a Scan Inbox nav
                  item, so it isn't duplicated here.) */}
              <NavLink to="/search" className={linkClass} onClick={() => setOpen(false)}>
                search
              </NavLink>

              <NavLink to="/calendar" className={linkClass} onClick={() => setOpen(false)}>
                calendar
              </NavLink>

              {tops.map((m) => {
                // Instance nav-group → a stem section label + its members as
                // indented instance rows (the inline segment treatment doesn't
                // fit a stacked mobile list).
                if (m.name.startsWith(NAVGROUP_PREFIX)) {
                  const g = instanceGroups.get(m.name);
                  if (!g) return null;
                  return (
                    <div key={m.name}>
                      {/* leading-5 matches text-sm's line box. Without it a
                          10px section label made a SHORTER row than a normal
                          link, so from that point down the left column's rules
                          no longer lined up with the right column's - the two
                          columns are independent flows and only equal row
                          heights keep their borders in step. */}
                      <div className={linkClass + " leading-5 text-faint dark:text-slate-500 uppercase text-[10px] font-mono tracking-widest"}>
                        {g.label}
                      </div>
                      {g.members.map((mem) => (
                        <button
                          key={mem.name}
                          type="button"
                          onClick={() => go(`/${mem.name.slice(INSTANCE_PREFIX.length)}`)}
                          className={childClass}
                        >
                          <ChildDot />
                          <span className="truncate">{mem.displayName}</span>
                        </button>
                      ))}
                    </div>
                  );
                }
                const kids = childrenByParent.get(m.name) ?? [];
                const isHeading = m.name.startsWith("__heading__");
                return (
                  <div key={m.name}>
                    {isHeading ? (
                      // A heading has no page — just a section label above
                      // its members. `leading-5` matches text-sm's line box:
                      // without it a 10px label made a SHORTER row than a
                      // normal link, so from there down the left column's rules
                      // stopped lining up with the right column's (the two
                      // columns are independent flows, and only equal row
                      // heights keep their borders in step).
                      <div className={linkClass + " leading-5 text-faint dark:text-slate-500 uppercase text-[10px] font-mono tracking-widest"}>
                        {m.displayName}
                      </div>
                    ) : (
                      <NavLink
                        to={
                          m.name.startsWith("__instance__")
                            ? `/${m.name.slice("__instance__".length)}`
                            : `/${m.name}`
                        }
                        className={linkClass}
                        onClick={() => setOpen(false)}
                      >
                        {m.displayName}
                      </NavLink>
                    )}
                    {kids.map((k) => {
                      const isInstance = k.name.startsWith("__instance__");
                      const to = isInstance
                        ? `/${k.name.slice("__instance__".length)}`
                        : isHeading
                          ? `/${k.name}`
                          : `/${m.name}?lens=${k.name}`;
                      // "instance" is gone: the dot and the heading above it
                      // already say this belongs to the parent. A LENS is a
                      // different thing (a filtered view of the parent rather
                      // than a table of its own) with no other signal for it,
                      // so that one keeps its word - it cannot cost a second
                      // line now that the row is a fixed height.
                      const badge = isInstance || isHeading ? "" : "lens";
                      return (
                        <button
                          key={k.name}
                          type="button"
                          onClick={() => go(to)}
                          className={childClass}
                        >
                          <ChildDot />
                          <span className="truncate">{k.displayName}</span>
                          {badge && (
                            <span className="shrink-0 text-[10px] font-mono text-faint">
                              {badge}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}

              </div>

              {/* Label queue lives here on mobile, as a menu row — the floating
                  bottom-right pill was covering page content + the thumb zone, so
                  it's desktop-only now. Self-hides when nothing is queued. */}
              {labelsEnabled && (
                <LabelsBasket
                  orgSlug={activeSlug}
                  getToken={getToken}
                  asRow
                  rowClassName={linkClass + " flex items-center gap-2"}
                  onNavigate={() => setOpen(false)}
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
                  <span className={footLabel}>profile</span>
                </NavLink>

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
          </div>,
          document.body,
        )}
    </>
  );
}
