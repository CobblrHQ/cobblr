// A small dropdown for header controls: a trigger plus a portaled panel.
//
// Portaled to document.body on purpose. The app header uses `backdrop-blur`,
// which makes it a containing block for fixed/absolute descendants, so a panel
// rendered inside it mis-positions (the trap NavCustomizeMenu and the Modal
// primitive both document). Everything here is generic: the scan header uses it
// for filing location, file intake, grouping and overflow, but nothing in it
// knows about scanning.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** The button. Gets the open state so it can show a pressed style. */
  trigger: (o: { open: boolean; toggle: () => void }) => ReactNode;
  /** Panel contents. `close` lets an item dismiss the menu when it acts. */
  children: (o: { close: () => void }) => ReactNode;
  /** Panel width in px. Default 232. */
  width?: number;
  /** Align the panel's right edge to the trigger's (for right-side triggers). */
  align?: "left" | "right";
  /**
   * Let this trigger absorb the squeeze in a nowrap row: it shrinks (and its
   * label truncates) instead of pushing the row into overflow. `minWidth` is the
   * legible floor - shrinking a location chip down to a bare pin icon is not a
   * saving, because answering "filed where?" is the whole reason it is there.
   */
  shrinkable?: boolean;
  minWidth?: number;
  className?: string;
}

export function HeaderMenu({
  trigger,
  children,
  width = 232,
  align = "left",
  shrinkable = false,
  minWidth,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open || !hostRef.current) return;
    const place = () => {
      const el = hostRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const M = 8;
      // Clamp into the viewport so a trigger near either edge still opens a
      // fully-visible panel - the narrow-screen case this menu exists for.
      let left = align === "right" ? r.right - width : r.left;
      left = Math.max(M, Math.min(left, window.innerWidth - width - M));
      setPos({ top: r.bottom + 6, left });
    };
    place();
    // Reposition rather than float away when the page moves under it.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (hostRef.current && !hostRef.current.contains(t) && !t.closest("[data-header-menu]")) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={hostRef}
      style={shrinkable && minWidth ? { minWidth } : undefined}
      className={
        "relative inline-flex " +
        (shrinkable ? "shrink min-w-0 " : "shrink-0 ") +
        (className ?? "")
      }
    >
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open &&
        pos &&
        createPortal(
          <div
            data-header-menu
            role="menu"
            style={{ top: pos.top, left: pos.left, width }}
            className="fixed z-[70] rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl py-1.5 text-sm"
          >
            {children({ close: () => setOpen(false) })}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** A section label inside a HeaderMenu. */
export function MenuHead({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint dark:text-slate-500">
      {children}
    </div>
  );
}

/** Explanatory copy inside a HeaderMenu - for scope a label cannot carry. */
export function MenuNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-2 text-[11px] leading-relaxed text-faint dark:text-slate-500">
      {children}
    </div>
  );
}

export function MenuSep() {
  return <div className="my-1 border-t border-line/70 dark:border-slate-700/70" />;
}

/** One action row. `state` renders a right-aligned value (on/off, a checkmark). */
export function MenuItem({
  icon,
  label,
  hint,
  state,
  onClick,
  disabled,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  state?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50 transition"
    >
      {icon ? <span className="mt-0.5 shrink-0 text-faint dark:text-slate-500">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        {/* Wraps rather than truncates: a menu is a fixed width holding whole
            sentences, so "Also set location on the 8 already here" cut to
            "already h..." loses the only part that says what it does. */}
        <span className="block">{label}</span>
        {hint ? (
          <span className="block text-[11px] leading-snug text-faint dark:text-slate-500">{hint}</span>
        ) : null}
      </span>
      {state ? <span className="ml-auto shrink-0 text-[11px] text-muted dark:text-slate-400">{state}</span> : null}
    </button>
  );
}
