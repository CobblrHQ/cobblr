// A row of actions that stays at the bottom of the screen while a page
// scrolls, and never covers what someone is working on.
//
// A bar pinned with `sticky bottom-0` sits over whatever scrolls beneath it,
// so the last field of a record, or one focused with the phone's keyboard up,
// ended up under "Duplicate · Move · Delete" (#3990). This bar reserves its
// own height as the page's scroll padding while it is on screen: the browser
// then scrolls a focused field, or one brought into view, clear of the bar.
// Every bottom-pinned bar is this one (capabilities: layout:sticky-bottom-bar).
// On the page it also pins above the toasts (--overlay-bottom, the room they
// take at the foot, bottom-dock.ts), so an Undo toast never sits on Delete
// (#5801); in a sheet the overlay already ends above them, and the bar sits on
// the sheet's edge, not a padding above it (#6782).

import { useEffect, useRef, type ReactNode } from "react";

/** The element that scrolls this one: a sheet's own scroller inside a modal,
 *  or the page. */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export function StickyBottomBar({ children, className = "", testId = "sticky-bottom-bar" }: { children: ReactNode; className?: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = scrollerOf(el);
    const onPage = scroller === document.scrollingElement || scroller === document.documentElement;
    if (onPage) el.style.bottom = "var(--overlay-bottom, 0px)";
    // In a sheet: a sticky box stops at its scroller's padding, so bottom-0
    // pinned the bar a padding above the sheet's edge and the record scrolled
    // past in the strip below it (#6782, the record sheet on every phone).
    // The bar sits on the edge itself.
    else {
      const pad = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
      if (pad > 0) el.style.bottom = `-${pad}px`;
    }
    const before = scroller.style.scrollPaddingBottom;
    const reserve = () => {
      const bar = Math.ceil(el.getBoundingClientRect().height) + 8;
      scroller.style.scrollPaddingBottom = onPage ? `calc(${bar}px + var(--overlay-bottom, 0px))` : `${bar}px`;
    };
    reserve();
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(reserve) : null;
    watch?.observe(el);
    return () => {
      watch?.disconnect();
      scroller.style.scrollPaddingBottom = before;
    };
  }, []);
  return (
    <div ref={ref} data-testid={testId} className={`sticky bottom-0 ${className}`}>
      {children}
    </div>
  );
}
