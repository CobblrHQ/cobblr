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
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  // A menu is a modal moment: the page must hold still under it. Without this
  // the page scrolled behind an open panel on both phone and desktop.
  //
  // DECLARED BEFORE the placement effect on purpose. Effects run in declaration
  // order, and locking the scroll changes the layout — so measuring the trigger
  // first means measuring a page that is about to move, and the panel lands
  // detached from the control that opened it (reported 2026-08-14: a menu opened
  // from a row far down the page rendered up near the top).
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !hostRef.current) return;
    const place = () => {
      const el = hostRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const M = 8;
      // On a narrow screen a fixed-px panel spends its height on WRAPPING: the
      // same hint that is one line on a desktop becomes three on a phone. So
      // the panel is allowed to grow LEFT there - up to a cap, never past the
      // viewport. The cap matters: a panel the full width of the screen stops
      // reading as a menu and starts reading as a sheet, and the page behind it
      // is part of how you know it is dismissible.
      const PHONE = window.innerWidth < 640;
      const w = PHONE
        ? Math.max(width, Math.min(340, window.innerWidth - 48))
        : Math.min(width, window.innerWidth - 2 * M);
      let left = align === "right" ? r.right - w : r.left;
      left = Math.max(M, Math.min(left, window.innerWidth - w - M));
      const top = r.bottom + 6;
      // Never taller than the room below the trigger. A long menu used to run
      // off the bottom of a phone with no way to reach the last item except
      // scrolling the PAGE, which dragged the panel along with it (reported
      // 2026-08-10). Cap it and let the panel scroll inside itself.
      setPos({ top, left, width: w, maxHeight: Math.max(160, window.innerHeight - top - M) });
    };
    place();
    // …and again on the next frame. Whatever the page does between the click and
    // the panel appearing — the scroll lock landing, a row expanding, a font
    // settling — the second pass measures the layout that actually exists.
    // NOT a fix for a diagnosed cause: a menu opening detached from its trigger
    // was reported 2026-08-14 and could not be reproduced headlessly, so this is
    // hardening against the class rather than a repair of a known mechanism.
    const raf = requestAnimationFrame(place);
    // Re-place on RESIZE only. It used to re-place on scroll too, which is why
    // the panel appeared to ride the page: it faithfully tracked a trigger that
    // was scrolling away. The page no longer scrolls while a menu is open (see
    // below), so there is nothing to track.
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
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
            style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
            className="fixed z-[70] overflow-y-auto overscroll-contain rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl py-1.5 text-sm"
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
    <div className="px-3 pt-1.5 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint dark:text-slate-500">
      {children}
    </div>
  );
}

/** A one-line, section-title-sized row for a FILTER - something that is neither
 *  a toggle nor an action worth a full row. "50 waiting 2d+" wore a switch and
 *  read as a setting you were turning on, which it never was (reported
 *  2026-08-10). Quiet by default, accent when the filter is applied. */
export function MenuFilterLine({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={!!active}
      onClick={onClick}
      className={
        "block w-full px-3 py-0.5 text-left text-[10.5px] uppercase tracking-wide transition hover:bg-subtle dark:hover:bg-slate-800 " +
        (active ? "text-accent" : "text-faint dark:text-slate-500")
      }
    >
      {children}
    </button>
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
      {/* A toggle has to LOOK like one. These rows were first-class controls
          before they were folded into this menu, and rendering their state as
          the words "on"/"off" made them read as labels rather than switches -
          you could not tell what tapping would do (reported 2026-08-10). An
          on/off state now renders a real switch; any other state stays text. */}
      {state === "on" || state === "off" ? (
        <span
          role="switch"
          aria-checked={state === "on"}
          className={
            "ml-auto mt-0.5 shrink-0 inline-flex h-4 w-7 items-center rounded-full transition " +
            (state === "on" ? "bg-cobble-600" : "bg-mortar-300 dark:bg-slate-600")
          }
        >
          <span
            className={
              "h-3 w-3 rounded-full bg-white shadow transition-transform " +
              (state === "on" ? "translate-x-3.5" : "translate-x-0.5")
            }
          />
        </span>
      ) : state ? (
        <span className="ml-auto shrink-0 text-[11px] text-muted dark:text-slate-400">{state}</span>
      ) : null}
    </button>
  );
}
