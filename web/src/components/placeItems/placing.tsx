// Place mode, as the floor plan sees it: while a place-items view wraps the
// plan, every room, zone and container is a target that says how many things
// it holds, and a tap on one either puts the things you picked up there or
// shows what is already in it. Outside a place-items view there is no context
// and the plan behaves as it always has.

import { createContext, useContext } from "react";

export interface Placing {
  /** Something is picked up: a tap on a place puts it there. */
  armed: boolean;
  /** How many things a place holds directly. */
  countAt: (locationId: string) => number;
  /** How many things a place holds, its sub-places included. */
  withinAt: (locationId: string) => number;
  /** A tap on a place, or a drop on it; on a plan's bare floor, with the
   *  exact spot (a pin, in that plan's mm). */
  pick: (locationId: string, position?: Pin | null) => void;
  /** The place a drag is over, to light it up. */
  over: string | null;
}

export const PlacingContext = createContext<Placing | null>(null);

export function usePlacing(): Placing | null {
  return useContext(PlacingContext);
}

/** An exact spot on a plan, in that plan's own mm. */
export interface Pin {
  x_mm: number;
  y_mm: number;
}

/** The attribute a place's rect carries, which a drag reads under the pointer. */
export const PLACE_TARGET = "data-place-target";
/** On a plan's own canvas (its bare floor, a face's background): "<w_mm>x<d_mm>",
 *  so a point there reads as a spot on that plan. */
export const PLACE_PLAN = "data-place-plan";

/** The spot a screen point is on, when `el` is a plan's canvas. */
export function pinAt(el: Element, x: number, y: number): Pin | null {
  const size = el.getAttribute(PLACE_PLAN);
  if (!size) return null;
  const [w, d] = size.split("x").map(Number);
  const r = el.getBoundingClientRect();
  if (!w || !d || !r.width || !r.height) return null;
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, Math.round(v)));
  return { x_mm: clamp(((x - r.left) / r.width) * w, w), y_mm: clamp(((y - r.top) / r.height) * d, d) };
}

/** The place under a point on the screen: the innermost target there, since a
 *  smaller rect draws above the one it sits in, and the spot when it is a
 *  plan's bare floor. */
export function placeAtPoint(x: number, y: number): { id: string; position: Pin | null } | null {
  const el = document.elementFromPoint(x, y);
  const t = el?.closest(`[${PLACE_TARGET}]`);
  const id = t?.getAttribute(PLACE_TARGET);
  return t && id ? { id, position: pinAt(t, x, y) } : null;
}
