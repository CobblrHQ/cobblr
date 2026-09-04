// Floating chrome must not sit on top of something you can press.
//
// The overlay flag next door (overlay-open.ts) makes chrome yield to MODALS and
// SIDE PANELS. It says nothing about the page's own content, so a fixed pill in
// the corner still lands on whatever happens to scroll under it.
//
// That is not hypothetical. On the scan card the feedback bubble sat on the
// Confirm button — the control that actually files your item — while a
// full-width secondary action sat above it looking like the confirm. Somebody
// pressed the wrong one twice and reported that there was "no clear option to
// add to yarn storage" (2026-07-15). One of those two problems was layout and
// one was hierarchy; this file is the layout half, and it is the half that
// recurs, because content moves and fixed chrome does not.
//
// A lint cannot catch it: whether a pill covers a button is a fact about
// LAYOUT AT RUNTIME, which no amount of reading the source will tell you. So
// the chrome checks for itself and gets out of the way.

import { useEffect, useState, type RefObject } from "react";

/** What counts as "you can press this". Disabled controls are excluded: they
 *  are not a thing the person is being stopped from doing. */
const PRESSABLE = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';

/** Applied by the chrome while it is covering something pressable. Translucent
 *  rather than hidden, and click-through, so the control underneath is both
 *  readable and reachable — a pill that vanishes and reappears while you scroll
 *  reads as a bug, and one that stays put eats your tap. */
export const YIELDING_CLASS = "opacity-20 pointer-events-none";

/** Is any element in this hit-stack pressable, ignoring the chrome itself?
 *
 *  Split out from the DOM plumbing so the RULE can be tested without a browser:
 *  the stack is whatever `elementsFromPoint` returned, topmost first.
 *  `isInside` says whether a node belongs to the chrome, `isPressable` whether
 *  it is something a person could press. */
export function pressableBeneath<T>(
  stack: readonly T[],
  isInside: (node: T) => boolean,
  isPressable: (node: T) => boolean,
): boolean {
  for (const node of stack) {
    if (isInside(node)) continue; // the chrome, and anything drawn inside it
    if (isPressable(node)) return true;
  }
  return false;
}

/** The points to test across a piece of chrome. Corners AND centre, inset by a
 *  pixel: a button clipped by one corner is still a button you cannot press,
 *  and testing the centre alone missed exactly that case. */
export function samplePoints(rect: { x: number; y: number; width: number; height: number }) {
  const { x, y, width: w, height: h } = rect;
  const i = 1;
  return [
    { x: x + i, y: y + i },
    { x: x + w - i, y: y + i },
    { x: x + i, y: y + h - i },
    { x: x + w - i, y: y + h - i },
    { x: x + w / 2, y: y + h / 2 },
  ];
}

/** True while this chrome is covering something pressable.
 *
 *  Recomputed on scroll and resize only — both rAF-coalesced — so it costs a
 *  handful of hit tests per frame at most, and nothing at all while the page is
 *  still. */
export function useYieldToContent<T extends HTMLElement>(ref: RefObject<T | null>): boolean {
  const [covering, setCovering] = useState(false);

  useEffect(() => {
    let frame = 0;
    let alive = true;

    const measure = () => {
      frame = 0;
      const el = ref.current;
      if (!el || !alive) return;
      // Never yield to something that is not on screen anyway.
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) { setCovering(false); return; }
      const hit = samplePoints(rect).some((p) => {
        const stack = document.elementsFromPoint(p.x, p.y);
        return pressableBeneath(
          stack,
          (n) => el.contains(n),
          (n) => {
            const c = (n as Element).closest?.(PRESSABLE);
            if (!c || el.contains(c)) return false;
            if ((c as HTMLButtonElement).disabled) return false;
            return c.getAttribute("aria-disabled") !== "true";
          },
        );
      });
      setCovering(hit);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    // `true` captures scrolls inside any nested scroller, not just the window.
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [ref]);

  return covering;
}
