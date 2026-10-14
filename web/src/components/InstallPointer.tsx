// The arrow at the browser's own bar, for the install walk's first tap.
//
// It points OUTSIDE the page, at Safari's ⋯ or Share, or at a browser's ⋮ menu,
// so it sits on the viewport's own edge and above whatever the walk is shown
// in (the tour's overlay, a sheet). That is why it is a bare fixed layer and
// named in lint-fixed-chrome's ALLOW: FloatingChrome's corner lifts above the
// dock and yields to overlays, which is right for page chrome and wrong for a
// pointer at the browser. It portals to <body>: the tour centres its card with
// a transform, and a transformed ancestor becomes the containing block of a
// fixed child, which put the arrow in the middle of the card instead of on the
// bar. Where it points comes from SAFARI_FIRST_TAP and
// installWalk (lib/install-app.ts), one line per layout.
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp } from "lucide-react";

export function InstallPointer({ at, label }: { at: "bottom-right" | "bottom-center" | "top-right"; label: string }) {
  const place =
    at === "bottom-right"
      ? "right-2 items-end bottom-[max(0.75rem,var(--inset-bottom))]"
      : at === "bottom-center"
        ? "left-1/2 -translate-x-1/2 items-center bottom-[max(0.75rem,var(--inset-bottom))]"
        : "right-2 items-end top-[max(0.5rem,var(--top-edge))] flex-col-reverse";
  return createPortal(
    <div data-install-pointer={at} className={`fixed z-[400] flex flex-col gap-1 pointer-events-none ${place}`}>
      <span className="whitespace-nowrap rounded-full bg-blue-500 px-2.5 py-1 text-xs font-semibold text-white shadow-lg">{label}</span>
      <span className="inline-flex h-10 w-10 animate-bounce items-center justify-center rounded-full bg-blue-500 text-white shadow-lg">
        {at === "top-right" ? <ArrowUp size={22} /> : <ArrowDown size={22} />}
      </span>
    </div>,
    document.body,
  );
}
