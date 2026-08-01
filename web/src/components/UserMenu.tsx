// Header-right account dropdown. Replaces the row of cryptic icon
// buttons (super-admin, calendar, configuration, profile name, theme
// toggle, sign-out) that crowded the navbar — folds them into one
// labelled menu. The trigger shows
// the display name + a "super-admin" chip when the user is a platform
// operator. Search, notifications + module quick-actions stay as their
// own navbar affordances.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Cable,
  CalendarDays,
  ChevronDown,
  LogOut,
  MessageSquare,
  Rocket,
  Sparkles,
  MessagesSquare,
  Moon,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  UserCog,
  Compass,
} from "lucide-react";
import { startTour } from "../tour/useTour";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useTheme } from "../theme/ThemeContext";
import { useThemeToggle } from "../theme/useThemeToggle";
import { UpdateBadge } from "./UpdateBadge";
import { GrowModal } from "./GrowModal";
import { PairPhoneButton } from "./PairPhoneButton";
import { api, isFocused, setFocused } from "../lib/api";
import { useMyEdgeBridge } from "../lib/useMyEdgeBridge";

/** Account-menu row showing the personal edge bridge's live status — only for
 *  users who actually run one. Same emerald/slate "online/offline" dot as the
 *  workspace device bridges, so the signal reads identically everywhere. */
function EdgeBridgeMenuRow({ itemCls, onNavigate }: { itemCls: string; onNavigate: () => void }) {
  const { hasBridge, connected } = useMyEdgeBridge();
  if (!hasBridge) return null;
  return (
    <Link to="/me/connections" onClick={onNavigate} className={itemCls} role="menuitem">
      <Cable size={14} className="text-faint dark:text-slate-400" /> Edge bridge
      <span className="ml-auto flex items-center gap-1.5 text-[11px] text-faint">
        <span
          className={"w-1.5 h-1.5 rounded-full " + (connected ? "bg-emerald-500" : "bg-slate-400/60")}
        />
        {connected ? "online" : "offline"}
      </span>
    </Link>
  );
}

// `themed` = a workspace admin_theme owns the palette, so the per-user
// light/dark toggle is hidden (it would just fight the theme).
export function UserMenu({ themed, inline = false }: { themed: boolean; inline?: boolean }) {
  // Managed app: strip the platform links (Calendar / What's new / Configuration
  // — the gateway to bundles, modules, wires, fields). Profile + feedback + sign
  // out remain so the user can still manage their own account.
  const { user, logout } = useAuth();
  const { activeSlug, activeOrg } = useActiveOrg();
  const appMode = !!activeOrg?.app_mode;
  // Simple mode (the `focused` flag): hide the build-it chrome (the Configuration
  // link below) for a calmer everyday view, but keep the workspace navigable.
  // Owner/admin flip it back via "Explore the full platform". A full reload
  // re-fetches /me so the whole shell re-renders (same pattern as switching
  // workspaces).
  const focused = isFocused(activeOrg);
  const canFocus = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const exitFocused = async () => {
    setOpen(false);
    try {
      await setFocused(activeSlug, false);
      window.location.reload();
    } catch {
      /* a failed toggle just leaves simple mode on; no destructive effect */
    }
  };
  const { theme } = useTheme();
  const toggle = useThemeToggle();
  const [open, setOpen] = useState(false);
  // Managed app: the "grow door" — the one deliberate exit to the rest of Cobblr.
  const [growOpen, setGrowOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Portaled to <body> so the header's overflow-x-clip + backdrop-blur don't
  // hide it; positioned `fixed` from the button's rect (right-aligned).
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right?: number; left?: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      // Sidebar FLYOUT (the Slack/Linear account-menu shape): open to the
      // RIGHT of the account row, over the content canvas, bottoms aligned —
      // never clips in the column, never crushes the nav above it.
      if (inline) {
        setPos({ left: r.right + 6, bottom: Math.max(8, window.innerHeight - r.bottom) });
        return;
      }
      const right = Math.max(8, window.innerWidth - r.right);
      // A trigger near the viewport bottom (the full-sidebar foot cluster)
      // opens UPWARD — a below-the-button menu would fall off-screen.
      if (window.innerHeight - r.bottom < 340) {
        setPos({ bottom: window.innerHeight - r.top + 4, right });
      } else {
        setPos({ top: r.bottom + 4, right });
      }
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Click-outside / Escape close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const isAdmin = !!user.is_platform_admin;
  const itemCls =
    "w-full flex items-center gap-2 px-3 py-2 text-sm text-content dark:text-slate-200 hover:bg-subtle dark:hover:bg-slate-700/60 transition";

  // Sidebar accordion (the author's "no dropdowns in the sidebar" rule): the menu
  // body renders IN-FLOW above the account row — no portal, no clipping, no
  // off-screen math. The popover path is untouched for the top bar.
  if (inline) {
    return (
      <div className="w-full">
        {open && pos && createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: "fixed", left: pos.left, bottom: pos.bottom }}
            className="w-60 max-h-[70vh] overflow-y-auto bg-surface dark:bg-slate-800 border border-line dark:border-slate-700 rounded-lg shadow-xl py-1 z-[100]"
          >
          {/* Identity header */}
          <div className="px-3 py-2 border-b border-line dark:border-slate-700">
            <div className="text-sm font-medium text-content dark:text-slate-100 truncate">
              {user.display_name}
            </div>
            <div className="text-[11px] text-faint dark:text-slate-400 truncate">{user.email}</div>
            {/* Unverified state lives here permanently (the top banner is
                one-dismissal now) — the action stays reachable. */}
            {user.email_verified === false && (
              <button
                type="button"
                onClick={() => void api.resendVerification().catch(() => undefined)}
                className="mt-1 text-[11px] text-amber-600 dark:text-amber-400 hover:underline"
              >
                email unverified - resend link
              </button>
            )}
            {isAdmin && (
              <div className="mt-1.5">
                <SuperAdminChip />
              </div>
            )}
          </div>

          {!inline && (
            <Link to="/me" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
              <UserCog size={14} className="text-faint dark:text-slate-400" /> Your account
            </Link>
          )}
          <Link to="/me/feedback" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
            <MessageSquare size={14} className="text-faint dark:text-slate-400" /> Your feedback
          </Link>
          {/* Pair phone (an established pattern): the phone IS the scanner; this is
              the desktop's door to it. Self-hides on touch devices. */}
          <PairPhoneButton className={itemCls} />
          {/* Managed app: the one settings surface — tailor the locked app (hide
              tables you don't use) without exposing the platform Configuration. */}
          {appMode && (
            <Link to="/me/app-settings" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
              <SlidersHorizontal size={14} className="text-faint dark:text-slate-400" /> Settings
            </Link>
          )}
          {/* Managed app: the grow door — start a full Cobblr workspace or jump
              to another. The one deliberate way out of the locked app. */}
          {appMode && (
            <button
              type="button"
              onClick={() => { setOpen(false); setGrowOpen(true); }}
              className={itemCls}
              role="menuitem"
            >
              <Rocket size={14} className="text-faint dark:text-slate-400" /> Do more with Cobblr
              <ArrowRight size={13} className="ml-auto text-faint dark:text-slate-500" />
            </button>
          )}
          {!appMode && (
            <>
              {!inline && (
                <Link to="/calendar" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
                  <CalendarDays size={14} className="text-faint dark:text-slate-400" /> Calendar
                </Link>
              )}
              <Link to="/changelog" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
                <Sparkles size={14} className="text-faint dark:text-slate-400" /> What's new
              </Link>
              <button type="button" onClick={() => { setOpen(false); startTour(); }} className={itemCls} role="menuitem">
                <Compass size={14} className="text-faint dark:text-slate-400" /> Take the tour
              </button>
              {/* Personal edge bridge liveness — only shows for users running one. */}
              <EdgeBridgeMenuRow itemCls={itemCls} onNavigate={() => setOpen(false)} />
              {/* Configuration is the build-it hub (modules / bundles / wires /
                  fields) — hidden in simple mode for a calmer everyday view. */}
              {!focused && !inline && (
                <Link
                  to="/configuration"
                  onClick={() => setOpen(false)}
                  className={itemCls}
                  role="menuitem"
                >
                  <SlidersHorizontal size={14} className="text-faint dark:text-slate-400" /> Configuration
                  {/* Bundles + their updates live under Configuration. */}
                  <UpdateBadge slug={activeSlug} variant="count" className="ml-auto" />
                </Link>
              )}
              {/* Simple mode's escape hatch — always reachable here. Labelled for
                  what it DOES ("Turn off simple mode"): an owner who turned simple
                  mode on looks for a "simple mode off" switch, not aspirational
                  "explore the platform" copy (which read as an upsell, not an exit). */}
              {focused && canFocus && (
                <button type="button" onClick={exitFocused} className={itemCls} role="menuitem">
                  <SlidersHorizontal size={14} className="text-accent dark:text-cobble-300" /> Turn off simple mode
                  <ArrowRight size={13} className="ml-auto text-faint dark:text-slate-500" />
                </button>
              )}
            </>
          )}
          {/* Community — only when an invite is configured (DISCORD_INVITE_URL). */}
          {user.discord_invite_url && (
            <a
              href={user.discord_invite_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className={itemCls}
              role="menuitem"
            >
              <MessagesSquare size={14} className="text-faint dark:text-slate-400" /> Community on Discord
            </a>
          )}

          {/* Platform-operator section — only for super-admins. */}
          {isAdmin && (
            <>
              <div className="my-1 border-t border-line dark:border-slate-700" />
              <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-400 flex items-center gap-1.5">
                <ShieldCheck size={11} /> Platform
              </div>
              {/* Plain anchor: the console is a top-level mount OUTSIDE this
                  workspace router — a <Link> would resolve under /w/:slug. */}
              <a
                href="/admin"
                onClick={() => setOpen(false)}
                className={itemCls}
                role="menuitem"
              >
                <Server size={14} className="text-faint dark:text-slate-400" /> Operator console
              </a>
            </>
          )}

          <div className="my-1 border-t border-line dark:border-slate-700" />
          {!themed && !inline && (
            <button
              onClick={() => {
                toggle();
                setOpen(false);
              }}
              className={itemCls}
              role="menuitem"
            >
              {theme === "dark" ? (
                <Sun size={14} className="text-faint dark:text-slate-400" />
              ) : (
                <Moon size={14} className="text-faint dark:text-slate-400" />
              )}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
          )}
          <button
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-content dark:text-slate-200 hover:bg-ember-50 hover:text-ember-600 dark:hover:bg-ember-500/10 transition"
            role="menuitem"
          >
            <LogOut size={14} className="text-faint dark:text-slate-400" /> Sign out
          </button>
          </div>,
          document.body,
        )}
        {/* The whole row opens the flyout — that's the 90% action. Profile
            lives INSIDE it as the first item (and the identity header). */}
        <button
          ref={btnRef}
          data-tour="account"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition"
          title={`${user.display_name} — account menu`}
        >
          <UserCog size={16} className="shrink-0" />
          <span className="font-medium truncate">{user.display_name}</span>
          {isAdmin && <SuperAdminChip />}
          <ChevronDown size={12} className={"ml-auto transition " + (open ? "" : "rotate-180")} />
        </button>
        {appMode && <GrowModal open={growOpen} onClose={() => setGrowOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        data-tour="account"
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700/60 transition"
        title={`${user.display_name} — account menu`}
      >
        <span className="font-medium">{user.display_name}</span>
        {isAdmin && <SuperAdminChip />}
        <ChevronDown size={12} className={open ? "rotate-180 transition" : "transition"} />
        {/* Bundle-updates signal — visible without opening the menu. */}
        {!open && (
          <span className="absolute -top-0.5 -right-0.5">
            <UpdateBadge slug={activeSlug} variant="dot" />
          </span>
        )}
      </button>

      {open && !inline && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: "fixed", top: pos.top, bottom: pos.bottom, right: pos.right }}
          className="w-56 max-w-[calc(100vw-1rem)] bg-surface dark:bg-slate-800 border border-line dark:border-slate-700 rounded-lg shadow-lg py-1 z-[100]"
        >
          {/* Identity header */}
          <div className="px-3 py-2 border-b border-line dark:border-slate-700">
            <div className="text-sm font-medium text-content dark:text-slate-100 truncate">
              {user.display_name}
            </div>
            <div className="text-[11px] text-faint dark:text-slate-400 truncate">{user.email}</div>
            {/* Unverified state lives here permanently (the top banner is
                one-dismissal now) — the action stays reachable. */}
            {user.email_verified === false && (
              <button
                type="button"
                onClick={() => void api.resendVerification().catch(() => undefined)}
                className="mt-1 text-[11px] text-amber-600 dark:text-amber-400 hover:underline"
              >
                email unverified - resend link
              </button>
            )}
            {isAdmin && (
              <div className="mt-1.5">
                <SuperAdminChip />
              </div>
            )}
          </div>

          {!inline && (
            <Link to="/me" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
              <UserCog size={14} className="text-faint dark:text-slate-400" /> Your account
            </Link>
          )}
          <Link to="/me/feedback" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
            <MessageSquare size={14} className="text-faint dark:text-slate-400" /> Your feedback
          </Link>
          {/* Pair phone (an established pattern): the phone IS the scanner; this is
              the desktop's door to it. Self-hides on touch devices. */}
          <PairPhoneButton className={itemCls} />
          {/* Managed app: the one settings surface — tailor the locked app (hide
              tables you don't use) without exposing the platform Configuration. */}
          {appMode && (
            <Link to="/me/app-settings" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
              <SlidersHorizontal size={14} className="text-faint dark:text-slate-400" /> Settings
            </Link>
          )}
          {/* Managed app: the grow door — start a full Cobblr workspace or jump
              to another. The one deliberate way out of the locked app. */}
          {appMode && (
            <button
              type="button"
              onClick={() => { setOpen(false); setGrowOpen(true); }}
              className={itemCls}
              role="menuitem"
            >
              <Rocket size={14} className="text-faint dark:text-slate-400" /> Do more with Cobblr
              <ArrowRight size={13} className="ml-auto text-faint dark:text-slate-500" />
            </button>
          )}
          {!appMode && (
            <>
              {!inline && (
                <Link to="/calendar" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
                  <CalendarDays size={14} className="text-faint dark:text-slate-400" /> Calendar
                </Link>
              )}
              <Link to="/changelog" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
                <Sparkles size={14} className="text-faint dark:text-slate-400" /> What's new
              </Link>
              <button type="button" onClick={() => { setOpen(false); startTour(); }} className={itemCls} role="menuitem">
                <Compass size={14} className="text-faint dark:text-slate-400" /> Take the tour
              </button>
              {/* Personal edge bridge liveness — only shows for users running one. */}
              <EdgeBridgeMenuRow itemCls={itemCls} onNavigate={() => setOpen(false)} />
              {/* Configuration is the build-it hub (modules / bundles / wires /
                  fields) — hidden in simple mode for a calmer everyday view. */}
              {!focused && !inline && (
                <Link
                  to="/configuration"
                  onClick={() => setOpen(false)}
                  className={itemCls}
                  role="menuitem"
                >
                  <SlidersHorizontal size={14} className="text-faint dark:text-slate-400" /> Configuration
                  {/* Bundles + their updates live under Configuration. */}
                  <UpdateBadge slug={activeSlug} variant="count" className="ml-auto" />
                </Link>
              )}
              {/* Simple mode's escape hatch — always reachable here. Labelled for
                  what it DOES ("Turn off simple mode"): an owner who turned simple
                  mode on looks for a "simple mode off" switch, not aspirational
                  "explore the platform" copy (which read as an upsell, not an exit). */}
              {focused && canFocus && (
                <button type="button" onClick={exitFocused} className={itemCls} role="menuitem">
                  <SlidersHorizontal size={14} className="text-accent dark:text-cobble-300" /> Turn off simple mode
                  <ArrowRight size={13} className="ml-auto text-faint dark:text-slate-500" />
                </button>
              )}
            </>
          )}
          {/* Community — only when an invite is configured (DISCORD_INVITE_URL). */}
          {user.discord_invite_url && (
            <a
              href={user.discord_invite_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className={itemCls}
              role="menuitem"
            >
              <MessagesSquare size={14} className="text-faint dark:text-slate-400" /> Community on Discord
            </a>
          )}

          {/* Platform-operator section — only for super-admins. */}
          {isAdmin && (
            <>
              <div className="my-1 border-t border-line dark:border-slate-700" />
              <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-400 flex items-center gap-1.5">
                <ShieldCheck size={11} /> Platform
              </div>
              {/* Plain anchor: the console is a top-level mount OUTSIDE this
                  workspace router — a <Link> would resolve under /w/:slug. */}
              <a
                href="/admin"
                onClick={() => setOpen(false)}
                className={itemCls}
                role="menuitem"
              >
                <Server size={14} className="text-faint dark:text-slate-400" /> Operator console
              </a>
            </>
          )}

          <div className="my-1 border-t border-line dark:border-slate-700" />
          {!themed && !inline && (
            <button
              onClick={() => {
                toggle();
                setOpen(false);
              }}
              className={itemCls}
              role="menuitem"
            >
              {theme === "dark" ? (
                <Sun size={14} className="text-faint dark:text-slate-400" />
              ) : (
                <Moon size={14} className="text-faint dark:text-slate-400" />
              )}
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
          )}
          <button
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-content dark:text-slate-200 hover:bg-ember-50 hover:text-ember-600 dark:hover:bg-ember-500/10 transition"
            role="menuitem"
          >
            <LogOut size={14} className="text-faint dark:text-slate-400" /> Sign out
          </button>
        </div>,
        document.body,
      )}
      {appMode && <GrowModal open={growOpen} onClose={() => setGrowOpen(false)} />}
    </div>
  );
}

function SuperAdminChip() {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-widest bg-cobble-100 text-cobble-700 dark:bg-cobble-500/20 dark:text-cobble-300 px-1.5 py-0.5 rounded">
      <ShieldCheck size={9} /> super-admin
    </span>
  );
}
