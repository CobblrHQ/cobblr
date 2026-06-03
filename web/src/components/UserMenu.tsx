// Header-right account dropdown. Replaces the row of cryptic icon
// buttons (super-admin, calendar, configuration, profile name, theme
// toggle, sign-out) that crowded the navbar — folds them into one
// labelled menu, mirroring companion app's UserMenu. The trigger shows
// the display name + a "super-admin" chip when the user is a platform
// operator. Search, notifications + module quick-actions stay as their
// own navbar affordances.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  ChevronDown,
  LogOut,
  Moon,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  UserCog,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";

// `themed` = a workspace admin_theme owns the palette, so the per-user
// light/dark toggle is hidden (it would just fight the theme).
export function UserMenu({ themed }: { themed: boolean }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-outside / Escape close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700/60 transition"
        title={`${user.display_name} — account menu`}
      >
        <span className="font-medium">{user.display_name}</span>
        {isAdmin && <SuperAdminChip />}
        <ChevronDown size={12} className={open ? "rotate-180 transition" : "transition"} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-56 bg-surface dark:bg-slate-800 border border-line dark:border-slate-700 rounded-lg shadow-lg py-1 z-50"
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
          </Link>

          {/* Platform-operator section — only for super-admins. */}
          {isAdmin && (
            <>
              <div className="my-1 border-t border-line dark:border-slate-700" />
              <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-400 flex items-center gap-1.5">
                <ShieldCheck size={11} /> Platform
              </div>
              <Link
                to="/super-admin"
                onClick={() => setOpen(false)}
                className={itemCls}
                role="menuitem"
              >
                <Server size={14} className="text-faint dark:text-slate-400" /> Super-admin
              </Link>
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
        </div>
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
