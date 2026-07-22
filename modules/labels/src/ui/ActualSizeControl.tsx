// The label-preview "Actual size" control: a toggle that renders the preview at
// its true physical size, plus a per-device screen-calibration ruler that only
// appears while Actual size is on (it means nothing next to a zoomed Big preview).
// Design + rationale: docs/design-decisions/label-codes.md + the approved mockup.

import { useRef, useState } from "react";
import { HelpCircle } from "lucide-react";
import type { ScreenCalibration } from "./useScreenCalibration";

const RULER_CM = 8; // fits inline beside the toggle; a real ruler is held against it

export function ActualSizeControl({
  actual,
  onToggle,
  cal,
}: {
  actual: boolean;
  onToggle: () => void;
  cal: ScreenCalibration;
}) {
  const [why, setWhy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rulerRef = useRef<HTMLDivElement>(null);

  const pxPerMm = cal.pxPerMm;
  const rulerW = RULER_CM * 10 * pxPerMm;

  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    setDragging(true);
    const left = rulerRef.current?.getBoundingClientRect().left ?? 0;
    const move = (ev: PointerEvent) => cal.setPxPerMm(Math.max(80, ev.clientX - left) / (RULER_CM * 10));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className="mt-2 flex items-center gap-3 text-xs">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={actual}
        title="Show the label at its true physical size on screen"
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition ${
          actual
            ? "border-cobble-500 bg-cobble-600 text-white"
            : "border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:border-cobble-400"
        }`}
      >
        <span
          className={`inline-block h-3 w-6 rounded-full relative transition-colors ${actual ? "bg-white/30" : "bg-slate-300 dark:bg-slate-600"}`}
        >
          <span className={`absolute top-px h-2.5 w-2.5 rounded-full bg-white transition-all ${actual ? "left-[13px]" : "left-px"}`} />
        </span>
        Actual size
      </button>

      {actual && (
        <>
          <div className="relative shrink-0" style={{ height: 24, width: rulerW + 26 }}>
            <div
              ref={rulerRef}
              className="absolute left-0 top-1 rounded-sm border border-line dark:border-slate-500 bg-surface dark:bg-slate-900"
              style={{ width: rulerW, height: 15 }}
            >
              {Array.from({ length: RULER_CM + 1 }, (_, cm) => {
                const x = cm * 10 * pxPerMm;
                const major = cm === 0 || cm === RULER_CM;
                return (
                  <span key={cm}>
                    <span
                      className={`absolute top-0 bottom-0 w-px ${major ? "bg-accent" : "bg-slate-400 dark:bg-slate-500"}`}
                      style={{ left: x }}
                    />
                    <span
                      className={`absolute text-[8px] tabular-nums -translate-x-1/2 ${major ? "text-accent font-bold" : "text-faint dark:text-slate-500"}`}
                      style={{ left: x, top: 15 }}
                    >
                      {cm}
                    </span>
                    {cm < RULER_CM && (
                      <span className="absolute top-[5px] bottom-0 w-px bg-slate-300 dark:bg-slate-600" style={{ left: x + 5 * pxPerMm }} />
                    )}
                  </span>
                );
              })}
            </div>
            <span className="absolute text-[8px] text-faint dark:text-slate-500" style={{ left: rulerW + 5, top: 15 }}>
              cm
            </span>
            <span
              onPointerDown={startDrag}
              title="Drag to match a real ruler"
              className="absolute top-0 flex items-center justify-center cursor-ew-resize -translate-x-1/2"
              style={{ left: rulerW, height: 19, width: 16 }}
            >
              <span className="w-[3px] h-[19px] rounded-sm bg-accent" />
            </span>
            {(dragging || !cal.calibrated) && (
              <span className="absolute -top-3 left-1.5 text-[10px] text-faint dark:text-slate-500 whitespace-nowrap">
                drag the end to your real {RULER_CM} cm ↔
              </span>
            )}
          </div>

          <div className="relative ml-auto shrink-0">
            <button type="button" onClick={() => setWhy((v) => !v)} title="Why calibrate?" className="text-faint hover:text-accent transition">
              <HelpCircle size={14} />
            </button>
            {why && (
              <div className="absolute right-0 bottom-6 w-64 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 text-[11px] text-muted dark:text-slate-400 leading-relaxed shadow-xl z-10">
                <b className="text-content dark:text-mortar-100">Why calibrate?</b> CSS millimetres assume 96 dpi, which
                almost no screen actually is, so "actual size" is a guess until the ruler matches a real one. Saved for
                this device; printing ignores it and uses true millimetres.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
