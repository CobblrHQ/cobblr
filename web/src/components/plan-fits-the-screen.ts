// How tall a floor plan may be so the whole room is on one screen: the room's
// bottom wall above the fold. A fixed share of the screen ("70% of the
// height") ignored where the plan starts, so under a page header, a tab row
// and the "not drawn yet" tray a 4 m × 3 m kitchen ran 180 px past the bottom
// of a 1440×900 screen (#4147). The cap is the room left below the plan's top,
// never more than the caller's share and never less than a floor that keeps a
// plan deep in a page readable.
import { useLayoutEffect, useState, type RefObject } from "react";

/** The plan's height cap in px. `top` is the plan's top edge as the page
 *  first lays it out (px from the top of the viewport). */
export function planHeightCap(viewportH: number, top: number, capVh: number): number {
  const share = (viewportH * capVh) / 100;
  const floor = viewportH * 0.35;
  const left = viewportH - top - 24;
  return Math.max(floor, Math.min(share, left));
}

/** Measure where the plan starts, when it is first drawn and when the window resizes, and
 *  return the cap. Scrolling does not change it: the question is whether the
 *  room fits the screen, asked where the page opens. */
export function usePlanHeightCap(ref: RefObject<HTMLElement | null>, capVh: number, drawn: boolean): number | null {
  const [cap, setCap] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el || typeof window === "undefined") return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setCap(planHeightCap(window.innerHeight, top, capVh));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // `drawn`: the plan's box only exists once there is a plan to draw.
  }, [ref, capVh, drawn]);
  return cap;
}
