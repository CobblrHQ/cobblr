// Generic modal primitive. Backdrop click + Esc close; backdrop is
// stationary while a child content panel scrolls if it overflows.
// Used by detail/edit modals across the app — never a new page when
// a modal will do.
//
// IMPORTANT: rendered through a portal to document.body. This isn't
// optional — any ancestor with `transform`, `filter`, `backdrop-
// filter`, or `perspective` becomes the containing block for fixed-
// positioned descendants, so a modal launched from inside the
// navbar (which uses backdrop-blur) would otherwise position
// relative to the navbar strip and intercept clicks only there.

import { useEffect, type ReactNode } from "react";
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
}

const SIZE: Record<NonNullable<Props["size"]>, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

export function Modal({ open, onClose, title, subtitle, children, size = "md", destructive }: Props) {
  useEffect(() => {
    if (!open) return;
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
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={
          "bg-surface dark:bg-slate-900 rounded-xl shadow-2xl border w-full my-12 " +
          SIZE[size] +
          " " +
          (destructive
            ? "border-ember-300 dark:border-ember-700"
            : "border-line dark:border-slate-700")
        }
        onClick={(e) => e.stopPropagation()}
      >
        {(title || subtitle) && (
          <div
            className={
              "flex items-start gap-3 px-5 py-3 border-b " +
              (destructive
                ? "border-ember-200 dark:border-ember-700/40"
                : "border-line dark:border-slate-700")
            }
          >
            <div className="flex-1 min-w-0">
              {title && (
                <div
                  className={
                    "font-display text-lg font-bold lowercase " +
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
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
