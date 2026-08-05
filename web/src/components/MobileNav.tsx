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
import { OverlayFlag } from "@cobblr/platform-web";

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

  const linkClass =
    "block px-4 py-3 text-sm border-b border-line dark:border-slate-800 " +
    "text-content dark:text-mortar-100 active:bg-subtle dark:active:bg-slate-800 transition";

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
            {/* backdrop — tap to dismiss */}
            <div
              className="absolute inset-0 bg-slate-900/40"
              onClick={() => setOpen(false)}
            />
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
              <div
                className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-line dark:border-slate-800"
                style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}
              >
                <span className="font-display font-extrabold text-content dark:text-mortar-100 lowercase">
                  cobblr
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

              <div className="flex-1 overflow-y-auto">
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
                      <div className={linkClass + " text-faint dark:text-slate-500 uppercase text-[10px] font-mono tracking-widest"}>
                        {g.label}
                      </div>
                      {g.members.map((mem) => (
                        <button
                          key={mem.name}
                          type="button"
                          onClick={() => go(`/${mem.name.slice(INSTANCE_PREFIX.length)}`)}
                          className={linkClass + " w-full text-left pl-8 text-muted dark:text-slate-400"}
                        >
                          {mem.displayName}
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
                      // its members.
                      <div className={linkClass + " text-faint dark:text-slate-500 uppercase text-[10px] font-mono tracking-widest"}>
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
                      const badge = isInstance ? "instance" : isHeading ? "" : "lens";
                      return (
                        <button
                          key={k.name}
                          type="button"
                          onClick={() => go(to)}
                          className={
                            linkClass +
                            " w-full text-left pl-8 text-muted dark:text-slate-400"
                          }
                        >
                          {k.displayName}
                          {badge && (
                            <span className="ml-2 text-[10px] font-mono text-faint">
                              {badge}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}

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

              <NavLink
                to="/me/notifications"
                className={linkClass + " flex items-center gap-2"}
                onClick={() => setOpen(false)}
              >
                <Bell size={14} />
                notifications
                {unreadCount > 0 && (
                  <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-ember-500 text-white text-[11px] font-semibold">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </NavLink>

              <NavLink
                to="/me"
                className={linkClass + " flex items-center gap-2"}
                onClick={() => setOpen(false)}
              >
                <UserCog size={14} />
                profile
              </NavLink>

              <NavLink
                to="/configuration"
                className={linkClass + " flex items-center gap-2"}
                onClick={() => setOpen(false)}
              >
                <Sliders size={14} />
                configuration
                {/* Right-aligned signals: a pending AI-share offer (amber dot,
                    owner-only) + bundle updates. Both live under Configuration. */}
                <span className="ml-auto flex items-center gap-1.5">
                  {pendingShares.length > 0 && (
                    <span
                      className="h-2 w-2 rounded-full bg-amber-500"
                      title="A shared AI is waiting for your approval"
                    />
                  )}
                  <UpdateBadge slug={activeSlug} variant="count" />
                </span>
              </NavLink>

              <button
                type="button"
                onClick={() => {
                  toggle();
                  setOpen(false);
                }}
                className={linkClass + " w-full text-left flex items-center gap-2"}
              >
                {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                {theme === "dark" ? "switch to light" : "switch to dark"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  logout();
                }}
                className={
                  linkClass +
                  " w-full text-left flex items-center gap-2 text-ember-500 dark:text-ember-500"
                }
              >
                <LogOut size={14} />
                sign out
              </button>
              </div>
            </nav>
          </div>,
          document.body,
        )}
    </>
  );
}
