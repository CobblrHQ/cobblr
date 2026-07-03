// Generic modal primitive. A backdrop click closes it — UNLESS you've started
// entering data inside it, in which case the backdrop is inert so a stray click
// can't discard your work (Esc + the explicit close/cancel always work).
//
// The distinction is automatic: viewing a detail modal? click outside to close.
// The instant you type into / change any field within, the modal flags itself
// "dirty" and the backdrop stops dismissing. So we never have to hand-tag which
// modals are "forms" vs "views" (and never miss one, reintroducing data loss).
// `dismissOnBackdrop={false}` is a HARD override for the rare modal that should
// never close on a backdrop click even when untouched.
// Used by detail/edit modals across the app — never a new page when
// a modal will do.
//
// IMPORTANT: rendered through a portal to document.body. This isn't
// optional — any ancestor with `transform`, `filter`, `backdrop-
// filter`, or `perspective` becomes the containing block for fixed-
// positioned descendants, so a modal launched from inside the
// navbar (which uses backdrop-blur) would otherwise position
// relative to the navbar strip and intercept clicks only there.

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title shown in a thin header bar with a close button. */
  title?: ReactNode;
  /** Optional small text below the title (mono, slate). */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Width preset. md (default) = 32rem; lg = 48rem; xl = 64rem. */
  size?: "sm" | "md" | "lg" | "xl";
  /** Tints the header to signal a destructive context. */
  destructive?: boolean;
  /** Render IN-FLOW as a card (same chrome, no portal/overlay/esc/scroll-lock).
   *  Lets a modal double as page content — the 2026-07-03 settings-cohesion
   *  fix: Configuration links must all land on pages, never pop overlays.
   *  onClose still powers the ✕ (usually navigate-back in page mode). */
  inline?: boolean;
  /** Whether a backdrop click can close the modal. **Default true**, but a click
   *  is ignored while the modal is "dirty" (you've typed into / changed a field),
   *  so unsaved input is never lost to a stray click. Set **false** to forbid
   *  backdrop-close entirely, even when untouched. */
  dismissOnBackdrop?: boolean;
}

const SIZE: Record<NonNullable<Props["size"]>, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

export function Modal({ open, onClose, title, subtitle, children, size = "md", destructive, dismissOnBackdrop = true, inline = false }: Props) {
  // "Dirty" = the user has entered/changed something inside this modal. Tracked
  // by listening (capture) for input/change events bubbling from any descendant
  // field — so we never have to know in advance whether a modal is a form. Only
  // real user interaction trips it (programmatic value changes / pre-filled
  // fields don't fire these), so a view modal with pre-filled controls still
  // closes on a backdrop click until you actually touch something.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (open) dirtyRef.current = false; // reset each time it opens
  }, [open]);
  const handleBackdrop = () => {
    if (!dismissOnBackdrop || dirtyRef.current) return;
    onClose();
  };
  const markDirty = () => {
    dirtyRef.current = true;
  };

  useEffect(() => {
    if (!open || inline) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    // Prevent background scroll while open
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, inline]);

  if (!open) return null;

  const panel = (
      <div
        className={
          // Height-constrained + column layout so a tall form scrolls WITHIN the
          // modal (header pinned) instead of running off the page (the bug Grace
          // hit). my-12 = 6rem of vertical margin, so cap at 100vh − 6rem.
          "bg-surface dark:bg-slate-900 rounded-xl shadow-2xl border w-full my-12 " +
          "flex flex-col max-h-[calc(100vh-6rem)] " +
          SIZE[size] +
          " " +
          (destructive
            ? "border-ember-300 dark:border-ember-700"
            : "border-line dark:border-slate-700")
        }
        onClick={(e) => e.stopPropagation()}
        // Any keystroke / change in a descendant field marks the modal dirty, so
        // the backdrop stops dismissing (protects unsaved input). Capture not
        // needed — these bubble — but onInput catches typing, onChange catches
        // selects/checkboxes/radios/files.
        onInput={markDirty}
        onChange={markDirty}
      >
        {(title || subtitle) && (
          <div
            className={
              "flex items-start gap-3 px-5 py-3 border-b shrink-0 " +
              (destructive
                ? "border-ember-200 dark:border-ember-700/40"
                : "border-line dark:border-slate-700")
            }
          >
            <div className="flex-1 min-w-0">
              {title && (
                <div
                  className={
                    "font-display text-lg font-bold " +
                    (destructive
                      ? "text-ember-700 dark:text-ember-300"
                      : "text-content dark:text-mortar-100")
                  }
                >
                  {title}
                </div>
              )}
              {subtitle && (
                <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mt-0.5">
                  {subtitle}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-faint dark:text-slate-500 hover:text-content dark:hover:text-mortar-100 transition shrink-0"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="p-5 flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
  );

  if (inline) {
    // Same panel, in document flow: no overlay, no height cap (the page
    // scrolls), full width of its container.
    return (
      <div className="w-full [&>div]:max-h-none [&>div]:my-0 [&>div]:w-full">{panel}</div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
    >
      {panel}
    </div>,
    document.body,
  );
}
