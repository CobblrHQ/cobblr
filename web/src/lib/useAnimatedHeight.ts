// A panel that changes size SLIDES to the new size; it never pops.
//
// reported 2026-08-03: "if we ever do go from a tall drawer to a short drawer I
// want that to be a smooth slide, not a gesture and the new size flashes."
// Swapping the capture drawer's contents re-rendered a taller (or shorter)
// box in one frame, so the sheet appeared to snap into existence at its new
// size — which reads as a glitch rather than as one surface changing shape.
//
// Height can't be transitioned from or to `auto`, so the panel is given an
// EXPLICIT pixel height that tracks its content. A ResizeObserver on the inner
// wrapper reports the natural height whenever the contents change, and the
// outer box transitions to it; `overflow-hidden` on the outer box clips the
// taller content while it grows, which is what makes it read as a slide.
//
// Deliberately generic and free of scan vocabulary — any collapsible surface
// should reach for this rather than re-deriving it, which is the point.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

/** How long the size change takes. Long enough to read as motion, short enough
 *  that it never delays a burst of captures. */
const SLIDE_MS = 260;
/** Standard ease-out: quick to commit, gentle to settle. */
const SLIDE_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useAnimatedHeight<T extends HTMLElement = HTMLDivElement>() {
  const [height, setHeight] = useState<number | null>(null);
  // The FIRST measurement must land without a transition, or the panel would
  // animate up from zero every time it appears. Motion is enabled a frame
  // later, once the opening size is already in place.
  const [animate, setAnimate] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);

  // A CALLBACK ref, not a ref + mount effect. The panels using this render
  // `null` until they have something to show, so a `[]`-deps effect runs once
  // against an empty ref, bails, and never observes anything — the panel then
  // has no measured height and silently never animates. A callback ref fires
  // whenever the node actually mounts, however late that is.
  const innerRef = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const measure = () => setHeight(node.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    observer.current = ro;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  useEffect(() => {
    if (height === null || animate) return;
    const raf = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(raf);
  }, [height, animate]);

  const style: CSSProperties =
    height === null
      ? {}
      : {
          height: `${Math.round(height)}px`,
          transition: animate && !prefersReducedMotion() ? `height ${SLIDE_MS}ms ${SLIDE_EASE}` : undefined,
        };

  return { innerRef, style };
}
