// One bar of a gantt, which a person can drag along the timeline to shift it
// and by its right end to change when it ends (#4173).
//
// Pointer: a mouse drags at once (past a few pixels, so a click still opens the
// record). A finger has to hold the bar first, as on the board, because a
// finger that moves at once is scrolling the timeline sideways. Keyboard: the
// bar is a slider; ←/→ shift it a day, Shift+←/→ move its end, and the change
// is written when the keys stop (or on Enter / leaving the bar); Escape puts
// it back.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { pxToDays } from "../../lib/view-dates";
import { swallowNextClick } from "../../lib/swallow-click";

type Mode = "move" | "resize";
const HOLD_MS = 250;
const SLOP_PX = 6;
const KEY_SETTLE_MS = 700;

export function GanttBar({
  left,
  width,
  milestone,
  perDay,
  spanDays,
  editable,
  label,
  onCommit,
}: {
  /** Percent of the track. */
  left: number;
  width: number;
  milestone: boolean;
  /** Percent of the track one day is. */
  perDay: number;
  spanDays: number;
  editable: boolean;
  label: string;
  onCommit: (days: number, mode: Mode) => void;
}) {
  const [preview, setPreview] = useState<{ days: number; mode: Mode } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    id: number;
    x0: number;
    y0: number;
    mode: Mode;
    live: boolean;
    touch: boolean;
    hold?: number;
  } | null>(null);
  const keyTimer = useRef<number | undefined>(undefined);

  // While a finger drags a bar, the page must not scroll under it. Only a
  // non-passive listener can refuse the browser's own pan.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (gesture.current?.live) e.preventDefault();
    };
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, []);
  useEffect(() => () => window.clearTimeout(keyTimer.current), []);

  const trackWidth = () => bar.current?.parentElement?.clientWidth ?? 0;
  const daysFor = (clientX: number) => pxToDays(clientX - (gesture.current?.x0 ?? clientX), trackWidth(), spanDays);

  const start = (e: ReactPointerEvent<HTMLElement>, mode: Mode) => {
    if (!editable || e.button > 0) return;
    e.stopPropagation();
    const touch = e.pointerType === "touch";
    const g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode, live: false, touch, hold: undefined as number | undefined };
    gesture.current = g;
    // From the press, not from when the drag is recognised: a bar's end is a
    // few pixels wide, and a pointer that leaves it before then would be lost.
    bar.current?.setPointerCapture?.(e.pointerId);
    if (touch) {
      g.hold = window.setTimeout(() => {
        if (gesture.current !== g) return;
        g.live = true;
        setPreview({ days: 0, mode });
      }, HOLD_MS);
    }
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.live) {
      if (Math.hypot(dx, dy) < SLOP_PX) return;
      // A finger that moved before the hold is scrolling, not dragging.
      if (g.touch) return end(e, true);
      g.live = true;
    }
    setPreview({ days: daysFor(e.clientX), mode: g.mode });
  };
  const end = (e: ReactPointerEvent<HTMLElement>, cancel = false) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    window.clearTimeout(g.hold);
    const days = daysFor(e.clientX);
    gesture.current = null;
    if (!g.live) return;
    swallowNextClick();
    setPreview(null);
    if (!cancel && days !== 0) onCommit(days, g.mode);
  };

  const settle = (p: { days: number; mode: Mode } | null) => {
    window.clearTimeout(keyTimer.current);
    setPreview(null);
    if (p && p.days !== 0) onCommit(p.days, p.mode);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!editable) return;
    if (e.key === "Escape" && preview) {
      e.preventDefault();
      window.clearTimeout(keyTimer.current);
      setPreview(null);
      return;
    }
    if (e.key === "Enter" && preview) {
      e.preventDefault();
      settle(preview);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const mode: Mode = e.shiftKey && !milestone ? "resize" : "move";
    const by = e.key === "ArrowLeft" ? -1 : 1;
    const next = { mode, days: (preview && preview.mode === mode ? preview.days : 0) + by };
    setPreview(next);
    window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => settle(next), KEY_SETTLE_MS);
  };

  const shift = preview ? preview.days * perDay : 0;
  const shownLeft = preview?.mode === "move" ? left + shift : left;
  const shownWidth = preview?.mode === "resize" ? Math.max(perDay, width + shift) : width;
  const pending = preview && preview.days !== 0 ? ` (${preview.mode === "move" ? "moved" : "ends"} ${preview.days > 0 ? "+" : ""}${preview.days} day${Math.abs(preview.days) === 1 ? "" : "s"})` : "";

  const handlers = editable
    ? {
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => start(e, "move"),
        onPointerMove: move,
        onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => end(e),
        onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => end(e, true),
        onKeyDown,
        onBlur: () => preview && settle(preview),
        tabIndex: 0,
        role: "slider",
        "aria-valuemin": -Math.round(spanDays),
        "aria-valuemax": Math.round(spanDays),
        "aria-valuenow": preview?.days ?? 0,
        "aria-valuetext": label + pending,
        "aria-roledescription": "timeline bar",
        "aria-description": milestone
          ? "Left and right arrows move it by a day."
          : "Left and right arrows move it by a day; with Shift they move when it ends.",
      }
    : {};

  return (
    <div
      ref={bar}
      {...handlers}
      data-gantt-bar=""
      className={
        "absolute top-1/2 -translate-y-1/2 h-4 rounded group " +
        (milestone ? "bg-amber-400 dark:bg-amber-500 min-w-[0.5rem] " : "bg-cobble-500 dark:bg-cobble-600 min-w-[0.25rem] ") +
        (editable ? "cursor-grab focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " : "") +
        (preview ? "ring-2 ring-accent shadow-lg" : "")
      }
      style={{ left: `${shownLeft}%`, width: `${shownWidth}%` }}
      title={label + pending}
    >
      {editable && !milestone && (
        <span
          aria-hidden
          data-gantt-end=""
          onPointerDown={(e) => start(e, "resize")}
          className="absolute right-0 top-0 bottom-0 w-3 -mr-1.5 cursor-ew-resize rounded-r flex items-center justify-center"
        >
          <span className="hover-reveal h-3 w-0.5 rounded bg-white/80 dark:bg-slate-900/70" />
        </span>
      )}
    </div>
  );
}
