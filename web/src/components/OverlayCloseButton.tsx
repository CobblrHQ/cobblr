import { X } from "lucide-react";

/**
 * The top-right close for a FULL-SCREEN overlay (`fixed inset-0`).
 *
 * Exists because `top-3 right-3` is wrong on a phone and looks right on a
 * laptop. A full-screen overlay's top edge is the physical top of the display,
 * so on a notched iPhone a 12px offset puts the button UNDER the status bar and
 * Dynamic Island, where the OS eats the tap: reported 2026-08-18 against the
 * scan inbox photo viewer, which had to be dismissed with the footer's Close
 * instead. The identical markup had been copied into the receipt viewer, which
 * has no footer and so was simply stuck.
 *
 * The inset is the fix, and a shared component is what stops the third copy.
 * `lint:overlay-safe-area` fails any hand-rolled equivalent.
 */
export function OverlayCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      style={{
        // The island's bottom edge IS the inset, so clear it by a hair rather
        // than landing flush against it. Unnotched hardware reports 0 and keeps
        // the original 12px.
        top: "max(0.75rem, calc(env(safe-area-inset-top) + 0.5rem))",
        right: "max(0.75rem, env(safe-area-inset-right))",
      }}
      // 44px is the smallest reliable touch target; the visual circle stays the
      // size it was, the reachable area does not.
      className="absolute z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white/90 hover:bg-black/70 hover:text-white transition"
      title="Close (Esc)"
      aria-label="Close"
    >
      <X size={20} />
    </button>
  );
}
