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
import { Sparkles, X } from "lucide-react";
import { useOverlayOpenFlag } from "./overlay-open";
import { useOverLiveSurface } from "./live-surface";
import { modalPanelLayout, modalOverlayPadding } from "./modal-layout";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional title shown in a thin header bar with a close button. */
  title?: ReactNode;
  /** Optional small text below the title (mono, slate). */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Width preset. md (default) = 32rem; lg = 48rem; xl = 64rem. */
  size?: "sm" | "md" | "lg" | "xl" | "content";
  /** Tints the header to signal a destructive context. */
  destructive?: boolean;
  /** Render IN-FLOW as a card (same chrome, no portal/overlay/esc/scroll-lock).
   *  Lets a modal double as page content — the 2026-07-03 settings-cohesion
   *  fix: Configuration links must all land on pages, never pop overlays.
   *  onClose still powers the ✕ (usually navigate-back in page mode). */
  inline?: boolean;
  /** With `inline`, drop the panel chrome too — no card border, no title bar, no
   *  ✕ — and render just the body. `inline` alone still draws the dialog's own
   *  header, so a settings ROUTE built this way read as a dialog stranded on a
   *  page while every neighbouring settings page had a plain heading. A route
   *  that owns its own heading passes this; a dialog opened over a page does
   *  not. Ignored unless `inline`. */
  chromeless?: boolean;
  /** Whether a backdrop click can close the modal. **Default true**, but a click
   *  is ignored while the modal is "dirty" (you've typed into / changed a field),
   *  so unsaved input is never lost to a stray click. Set **false** to forbid
   *  backdrop-close entirely, even when untouched. */
  dismissOnBackdrop?: boolean;
  /** CLAIM the available height: the panel grows to (nearly) the full viewport
   *  and its body scrolls within, instead of shrinking to its content and
   *  leaving a dead band above/below. For content-heavy working surfaces where
   *  "no use wasting screen space" (the author). Off by default so a small confirm
   *  dialog still sizes to its content. */
  fillHeight?: boolean;
  /** A contextual **Ask Cobb** button in the header. `prompt` is a ready-to-go
   *  starter typed into the chat for the user (editable, one tap to send) — a
   *  modal's "help me understand / act on what's in front of me" front door. The
   *  chat docks alongside (it sits z-above modals and the shell reserves its
   *  edge), so no screen needs its own chat coupling. Works in any nav mode: the
   *  button lives IN the modal, so it dodges the launcher-under-backdrop problem. */
  /** `opener` is what Cobb SAYS when the button opens the chat — a greeting that
   *  frames this modal ("You're on your label codes. I can rename a prefix or…"),
   *  rendered as an assistant turn, not words typed into the user's box. Write it
   *  in Cobb's voice, using the screen's real vocabulary. */
  cobb?: { opener: string; label?: string };
}

const SIZE: Record<NonNullable<Props["size"]>, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
  /** The standard content column's width (max-w-4xl) — a modal that should
   *  read as "the page, focused" rather than wider than the strips under it. */
  content: "max-w-4xl",
};

export function Modal({ open, onClose, title, subtitle, children, size = "md", destructive, dismissOnBackdrop = true, inline = false, chromeless = false, fillHeight = false, cobb }: Props) {
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
  // Floating chrome (the Live pill, Quick access) out-stacks this overlay, so
  // it has to yield while we're up. `inline` is page content, not an overlay.
  useOverlayOpenFlag(open && !inline);
  // Over a LIVE surface (the camera viewfinder) a modal stays a card at every
  // width: full-bleed would hide the thing the user is pointing at. Declared by
  // the surface, not by each modal - see live-surface.tsx.
  const overLive = useOverLiveSurface();
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
        // A surface marked data-modal-escape-exempt (the docked chat panel)
        // coexists with modals — its Escape must not close them.
        if (e.target instanceof HTMLElement && e.target.closest("[data-modal-escape-exempt]")) return;
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
          // hit). my-8 = 4rem of vertical margin (was 6rem — a content-heavy
          // modal like the put-away plan was wasting a band of screen top and
          // bottom, the author 2026-07-11), so cap at 100vh − 4rem to match.
          // On a PHONE a modal is the whole screen: no margin, no radius, no
          // wasted band — a floating card with 1rem gutters wastes the little
          // room there is and pushed action rows under the Live pill (the author,
          // 2026-08-01). From sm up it's the familiar centred card again.
          "bg-surface dark:bg-slate-900 shadow-2xl border w-full flex flex-col " +
          modalPanelLayout(overLive, fillHeight) +
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
        {(title || subtitle || cobb) && (
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
            {cobb && (
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("cobblr:open-chat", { detail: { opener: cobb.opener } }))
                }
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-accent hover:bg-subtle dark:hover:bg-slate-800 transition shrink-0"
                title="Ask Cobb about this — opens chat with Cobb ready to help"
              >
                <Sparkles size={15} className="shrink-0" />
                <span className="hidden sm:inline">{cobb.label ?? "Ask Cobb"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              // Full 44×44 tap target: a bare 16px icon flush to the screen edge
              // was unhittable on mobile (it sits in the browser's edge-swipe
              // gutter, well under the ~44px touch minimum), trapping users in the
              // modal with no way out. min-h/w-11 = 44px guarantees the WCAG 2.5.5
              // target size regardless of icon size (p-2.5 alone left it at 38px);
              // -m-1.5 pulls the box back so the centered icon stays aligned.
              className="-m-1.5 inline-flex items-center justify-center min-h-11 min-w-11 rounded-lg text-faint dark:text-slate-500 hover:text-content dark:hover:text-mortar-100 hover:bg-mortar-100/60 dark:hover:bg-slate-800 transition shrink-0 touch-manipulation"
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="p-5 flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
  );

  if (inline) {
    // AS A PAGE: body only, so the host route's own heading is the heading.
    if (chromeless) return <div className="w-full">{children}</div>;
    // Same panel, in document flow: no overlay, no height cap (the page
    // scrolls), full width of its container.
    return (
      <div className="w-full [&>div]:max-h-none [&>div]:my-0 [&>div]:w-full">{panel}</div>
    );
  }

  return createPortal(
    <div
      // Center within the CONTENT area, not the raw viewport: the app shell
      // publishes its reserved edges (pinned left sidebar, docked right panel)
      // as --modal-inset-left/right on <html>, and the overlay pads by them —
      // "the active window is the part without the sidebar" (the author).
      // Defaults to 0, so shells without chrome are unaffected.
      className={
        "fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-start justify-center overflow-y-auto md:pl-[calc(1rem+var(--modal-inset-left,0px))] xl:pr-[calc(1rem+var(--modal-inset-right,0px))] " +
        modalOverlayPadding(overLive)
      }
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
    >
      {panel}
    </div>,
    document.body,
  );
}
