// Screen calibration for the "Actual size" label preview.
//
// CSS millimetres assume 96 dpi, which almost no real display is, so rendering a
// label at its true physical size is a guess until the screen is measured. The
// user does that once by holding a real ruler against an on-screen one and
// dragging it to match; we store the correction PER DEVICE (localStorage — a
// screen's dpi is a property of the machine, not the workspace). Printing never
// uses this (a printer honours real mm directly); it only makes the on-SCREEN
// preview physically true. Same trick as the datamatrix scan-ladder.

import { useCallback, useState } from "react";

const CAL_KEY = "cobblr.screen-calibration"; // per-device %; absent = never calibrated
const MIN_PCT = 60;
const MAX_PCT = 180;

/** Measure the browser's CSS px per millimetre by laying out a 100mm probe.
 *  Reflects the display's real pixel density only after calibration; before
 *  that it's the 96dpi assumption. */
function measurePxPerMm(): number {
  if (typeof document === "undefined") return 96 / 25.4;
  const probe = document.createElement("div");
  probe.style.cssText = "width:100mm;position:absolute;visibility:hidden;pointer-events:none;left:-9999px";
  document.body.appendChild(probe);
  const v = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return v > 0 ? v : 96 / 25.4;
}

function loadPct(): number {
  try {
    const v = Number(localStorage.getItem(CAL_KEY));
    return Number.isFinite(v) && v >= MIN_PCT && v <= MAX_PCT ? v : 100;
  } catch {
    return 100;
  }
}
function hasSaved(): boolean {
  try {
    return localStorage.getItem(CAL_KEY) != null;
  } catch {
    return false;
  }
}

export interface ScreenCalibration {
  /** The browser's raw CSS px/mm (the 96dpi lie until calibrated). */
  nativePxPerMm: number;
  /** Calibrated CSS px/mm — what "actual size" scales by. */
  pxPerMm: number;
  /** The saved correction, 60–180. 100 = the browser's own assumption. */
  calPct: number;
  /** Whether the user has ever set it (else "actual size" is still a guess). */
  calibrated: boolean;
  /** Set from a target px/mm (what the ruler-drag produces); clamped + saved. */
  setPxPerMm(pxPerMm: number): void;
  reset(): void;
}

export function useScreenCalibration(): ScreenCalibration {
  const [nativePxPerMm] = useState(measurePxPerMm);
  const [calPct, setCalPct] = useState(loadPct);
  const [calibrated, setCalibrated] = useState(hasSaved);

  const setPxPerMm = useCallback(
    (pxPerMm: number) => {
      const pct = Math.max(MIN_PCT, Math.min(MAX_PCT, (pxPerMm / nativePxPerMm) * 100));
      setCalPct(pct);
      setCalibrated(true);
      try {
        localStorage.setItem(CAL_KEY, String(pct));
      } catch {
        /* private mode / disabled storage — calibration just won't persist */
      }
    },
    [nativePxPerMm],
  );

  const reset = useCallback(() => {
    setCalPct(100);
    setCalibrated(false);
    try {
      localStorage.removeItem(CAL_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return {
    nativePxPerMm,
    pxPerMm: (nativePxPerMm * calPct) / 100,
    calPct,
    calibrated,
    setPxPerMm,
    reset,
  };
}
