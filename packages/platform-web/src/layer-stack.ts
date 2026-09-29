// Which floating layer is on top: the one opened last.
//
// Every layer picked its own z-index (a modal 50, the Ask Cobb panel 60, the
// confirm dialog 60, the menus 61 to 130), so the order between two of them was
// whatever two authors happened to choose. On a phone, a modal opened from
// inside Ask Cobb landed UNDER the panel: its header strip showed and nothing in
// it could be pressed (#3954). The rule is now kept here, once: a layer goes
// above every layer opened before it, whatever number it asked for, and keeps
// the number it asked for when that is already higher. A layer opened alone
// keeps its own z-index, so nothing that already stacked correctly moves.
//
// "Opened before" is RENDER order, taken while rendering (a parent renders
// before its children), never effect order: React runs a child's layout effect
// before its parent's, so a panel and the modal inside it mounted in one commit
// would otherwise stack the modal first and the panel over it.

import { useLayoutEffect, useState, type RefObject } from "react";

interface Layer {
  seq: number;
  own: number;
  el: HTMLElement;
}

let nextSeq = 0;
const open = new Set<Layer>();

/** The z-index a layer asking for `own` gets over a layer at `below`: its own
 *  when that is already higher, else just above. Pure, so the rule is tested
 *  without a browser. */
export function stackedZ(own: number, below: number): number {
  return own > below ? own : below + 1;
}

/** The z-index of the highest layer open right now, or 0. */
export function topLayerZ(): number {
  let top = 0;
  for (const l of open) top = Math.max(top, Number.parseInt(l.el.style.zIndex, 10) || l.own);
  return top;
}

function restack() {
  let below = 0;
  for (const l of [...open].sort((a, b) => a.seq - b.seq)) {
    const z = stackedZ(l.own, below);
    const want = z === l.own ? "" : String(z);
    if (l.el.style.zIndex !== want) l.el.style.zIndex = want;
    below = z;
  }
}

/** Put the element in `ref` in the stack while it is mounted. Its own z-index
 *  is read from its computed style, so callers keep saying it as they do. */
export function useLayerStack(ref: RefObject<HTMLElement | null>): void {
  const [seq] = useState(() => ++nextSeq);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const own = Number.parseInt(window.getComputedStyle(el).zIndex, 10);
    const layer: Layer = { seq, own: Number.isFinite(own) ? own : 0, el };
    open.add(layer);
    restack();
    return () => {
      open.delete(layer);
      el.style.zIndex = "";
      restack();
    };
  }, [ref, seq]);
}
