// Header-right account dropdown. Replaces the row of cryptic icon
// buttons (super-admin, calendar, configuration, profile name, theme
// toggle, sign-out) that crowded the navbar — folds them into one
// labelled menu, mirroring companion app's UserMenu. The trigger shows
// the display name + a "super-admin" chip when the user is a platform
// operator. Search, notifications + module quick-actions stay as their
// own navbar affordances.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  ChevronDown,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Moon,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  UserCog,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useTheme } from "../theme/ThemeContext";
import { UpdateBadge } from "./UpdateBadge";

// `themed` = a workspace admin_theme owns the palette, so the per-user
// light/dark toggle is hidden (it would just fight the theme).
export function UserMenu({ themed }: { themed: boolean }) {
  const { user, logout } = useAuth();
  const { activeSlug } = useActiveOrg();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Portaled to <body> so the header's overflow-x-clip + backdrop-blur don't
  // hide it; positioned `fixed` from the button's rect (right-aligned).
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
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

  return (
    <div className="relative">
      <button
        ref={btnRef}
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

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: "fixed", top: pos.top, right: pos.right }}
          className="w-56 max-w-[calc(100vw-1rem)] bg-surface dark:bg-slate-800 border border-line dark:border-slate-700 rounded-lg shadow-lg py-1 z-[100]"
        >
          {/* Identity header */}
          <div className="px-3 py-2 border-b border-line dark:border-slate-700">
            <div className="text-sm font-medium text-content dark:text-slate-100 truncate">
              {user.display_name}
            </div>
            <div className="text-[11px] text-faint dark:text-slate-400 truncate">{user.email}</div>
            {isAdmin && (
              <div className="mt-1.5">
                <SuperAdminChip />
              </div>
            )}
          </div>

          <Link to="/me" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
            <UserCog size={14} className="text-faint dark:text-slate-400" /> Your profile
          </Link>
          <Link to="/me/feedback" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
            <MessageSquare size={14} className="text-faint dark:text-slate-400" /> Your feedback
          </Link>
          <Link to="/calendar" onClick={() => setOpen(false)} className={itemCls} role="menuitem">
            <CalendarDays size={14} className="text-faint dark:text-slate-400" /> Calendar
          </Link>
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
          {!themed && (
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
