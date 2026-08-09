// Auto-zoom: put more pixels on a code that is too small to read, instead of
// asking the user to lean in.
//
// "Scanning takes a while and needs me to fiddle with the distance" (reported
// 2026-08-04). Distance was the one lever with no answer: focus is
// unsupported on the device, lighting is the torch's job, angle is the
// orientation estimator's. Zoom is available (1-10 on the reference iPhone) and until
// now was a manual ?zoom=N knob.
//
// The signal is free. The orientation estimator already locates the barcode
// on every missed frame and reports its region as a FRACTION of the frame, so
// "the code is small in view" needs no new measurement — and a fraction is
// resolution independent, which a pixel count would not be.
//
// The discipline is the torch's, learned the hard way: hysteresis and a step
// cooldown, so the lens never hunts. One step at a time, never while a decode
// is landing, and back off to wide when there is nothing to aim at (a narrow
// field of view costs you the ability to FIND a code, which is worse than a
// slow read).

export interface ZoomConfig {
  min: number;
  max: number;
  /** How much to move per step. Small enough that a wrong guess is cheap. */
  step: number;
  /** Never move more often than this. */
  stepEveryMs: number;
  /** A located code narrower than this fraction of the frame is too small. */
  smallFrac: number;
  /** ...and wider than this means zoom is not the problem (it may even be
   *  cropping the quiet zones a 1D code needs), so back off. */
  bigFrac: number;
  /** Nothing code-like in view for this long → ease back to wide, where
   *  finding a code is easiest. */
  emptyMs: number;
}

export const ZOOM_DEFAULTS: ZoomConfig = {
  min: 1,
  max: 3,
  step: 0.5,
  stepEveryMs: 1200,
  smallFrac: 0.25,
  bigFrac: 0.55,
  emptyMs: 4000,
};

export interface ZoomState {
  zoom: number;
  lastChangeAt: number;
  emptySince: number | null;
}

export function zoomInitial(zoom = 1): ZoomState {
  return { zoom, lastChangeAt: 0, emptySince: null };
}

export interface ZoomSample {
  /** Width of the located barcode region as a fraction of the frame, or null
   *  when the estimator found nothing code-like. */
  regionWidth: number | null;
  /** A code was read this frame. */
  decoded: boolean;
}

/** Feed one frame's outcome; get the next state and a zoom to apply (or null
 *  when nothing should move). */
export function zoomPlan(
  s: ZoomState,
  sample: ZoomSample,
  now: number,
  cfg: ZoomConfig = ZOOM_DEFAULTS,
): { state: ZoomState; target: number | null } {
  // It is working. Never move the lens out from under a successful read —
  // whatever this zoom is, it is the right one for what the user is doing.
  if (sample.decoded) return { state: { ...s, emptySince: null }, target: null };

  const canStep = now - s.lastChangeAt >= cfg.stepEveryMs;

  if (sample.regionWidth === null) {
    // Nothing code-like in view. Give it a while (the user may be lining up a
    // shot), then widen: a narrow field makes FINDING a code harder, and that
    // is the worse failure.
    const emptySince = s.emptySince ?? now;
    if (now - emptySince >= cfg.emptyMs && canStep && s.zoom > cfg.min) {
      const zoom = Math.max(cfg.min, round(s.zoom - cfg.step));
      return { state: { zoom, lastChangeAt: now, emptySince }, target: zoom };
    }
    return { state: { ...s, emptySince }, target: null };
  }

  if (!canStep) return { state: { ...s, emptySince: null }, target: null };

  if (sample.regionWidth < cfg.smallFrac && s.zoom < cfg.max) {
    const zoom = Math.min(cfg.max, round(s.zoom + cfg.step));
    return { state: { zoom, lastChangeAt: now, emptySince: null }, target: zoom };
  }
  if (sample.regionWidth > cfg.bigFrac && s.zoom > cfg.min) {
    const zoom = Math.max(cfg.min, round(s.zoom - cfg.step));
    return { state: { zoom, lastChangeAt: now, emptySince: null }, target: zoom };
  }
  return { state: { ...s, emptySince: null }, target: null };
}

/** Keep the value clean — a float drift like 2.4999999 is a nuisance in the
 *  diagnostics readout and in constraint equality checks. */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Does this track support zoom, and within what bounds? */
export function zoomRange(track: MediaStreamTrack | null): { min: number; max: number } | null {
  const caps = (track as unknown as { getCapabilities?: () => { zoom?: { min?: number; max?: number } } })
    ?.getCapabilities?.();
  const z = caps?.zoom;
  if (!z || typeof z.min !== "number" || typeof z.max !== "number") return null;
  return { min: z.min, max: z.max };
}
