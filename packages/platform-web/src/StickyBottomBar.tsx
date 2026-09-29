// A row of actions that stays at the bottom of the screen while a page
// scrolls, and never covers what someone is working on.
//
// A bar pinned with `sticky bottom-0` sits over whatever scrolls beneath it,
// so the last field of a record, or one focused with the phone's keyboard up,
// ended up under "Duplicate · Move · Delete" (#3990). This bar reserves its
// own height as the page's scroll padding while it is on screen: the browser
// then scrolls a focused field, or one brought into view, clear of the bar.
// Every bottom-pinned bar is this one (capabilities: layout:sticky-bottom-bar).

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
    const before = scroller.style.scrollPaddingBottom;
    const reserve = () => {
      scroller.style.scrollPaddingBottom = `${Math.ceil(el.getBoundingClientRect().height) + 8}px`;
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
