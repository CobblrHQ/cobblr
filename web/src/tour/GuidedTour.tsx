// The coachmark engine: dim the screen, spotlight one real element, show a step
// card. It reads each step's target LIVE (getBoundingClientRect), so it needs no
// hardcoded coordinates and works in either nav layout — the element is found
// wherever it happens to be. A step whose target is not on the page is skipped.
// The step content + order come from tour.config.ts.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Moon, Sun } from "lucide-react";
import { useNavMode } from "../lib/nav-mode";
import { useTheme } from "../theme/ThemeContext";
import { LAYOUT_OPTIONS, type TourStep } from "./tour.config";
import { OverlayFlag } from "@cobblr/platform-web";

const PAD = 8; // breathing room around the spotlit element
const GAP = 14; // spotlight-to-card gap
const SCRIM = "rgba(6,10,20,0.72)";

/** First VISIBLE element for a target. A target may be an ORDERED list of
 *  selectors: we return the first on-screen match, so a step can prefer one
 *  anchor (e.g. the capture-card scan button) and fall back to another (the
 *  always-present header camera). The nav also renders in both the top bar and
 *  the sidebar (only one shown), so within a selector we pick the visible one. */
function findVisible(target: string | string[]): HTMLElement | null {
  for (const selector of Array.isArray(target) ? target : [target]) {
    const hit = Array.from(document.querySelectorAll<HTMLElement>(selector)).find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.offsetParent !== null;
    });
    if (hit) return hit;
  }
  return null;
}

export function GuidedTour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardPos, setCardPos] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const navMode = useNavMode();
  const { theme, toggle: toggleTheme } = useTheme();
  const step = steps[i];

  // Move, skipping spotlight steps whose target isn't present. Past either end closes.
  const move = useCallback(
    (dir: 1 | -1) => {
      let n = i;
      for (;;) {
        n += dir;
        if (n < 0 || n >= steps.length) return onClose();
        const s = steps[n];
        if (!s || s.kind !== "spotlight" || findVisible(s.target)) return setI(n);
      }
    },
    [i, steps, onClose],
  );

  // Track the target's rect (reposition on scroll/resize + a slow poll for late shifts).
  useLayoutEffect(() => {
    if (!step || step.kind !== "spotlight") {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = findVisible(step.target);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const id = window.setInterval(measure, 400);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.clearInterval(id);
    };
  }, [step]);

  // Place the card near the spotlight (to the side of a tall left sidebar; else below/above).
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !step || step.kind !== "spotlight" || !rect) {
      setCardPos(null);
      return;
    }
    const vw = window.innerWidth, vh = window.innerHeight, cw = card.offsetWidth, ch = card.offsetHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    if (rect.height > vh * 0.35 && rect.width < vw * 0.25 && rect.left < vw * 0.4) {
      setCardPos({ left: rect.right + GAP + PAD, top: clamp(rect.top, 12, vh - ch - 12) });
      return;
    }
    let top = rect.bottom + GAP + PAD;
    if (top + ch > vh - 12) top = rect.top - PAD - GAP - ch;
    setCardPos({ left: clamp(rect.left + rect.width / 2 - cw / 2, 12, vw - cw - 12), top: clamp(top, 12, vh - ch - 12) });
  }, [step, rect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, onClose]);

  const spots = steps.filter((s) => s.kind === "spotlight").length;
  const spotAt = steps.slice(0, i + 1).filter((s) => s.kind === "spotlight").length;

  const surface = "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100";
  const card = `fixed z-[210] w-[320px] max-w-[calc(100vw-24px)] rounded-2xl ${surface} shadow-2xl p-4`;
  const pri = "inline-flex items-center gap-1.5 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-sm font-semibold px-4 py-2 transition";
  const ghost = "inline-flex items-center gap-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-100 text-sm font-semibold px-4 py-2 transition";
  const skip = "text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 text-xs px-1 py-1.5 transition";
  const kicker = "text-[11px] font-bold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-300 mb-2";
  const muted = "text-slate-500 dark:text-slate-400";

  if (!step) return null;

  // Clamp the spotlight outline so it never runs off a viewport edge (an element
  // flush against the left/top would otherwise lose its border under the -PAD).
  const EDGE = 6; // keep the outline at least this far inside the viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  const spotBox = rect
    ? (() => {
        const l = Math.max(rect.left - PAD, EDGE);
        const t = Math.max(rect.top - PAD, EDGE);
        return { left: l, top: t, width: Math.min(rect.right + PAD, vw - EDGE) - l, height: Math.min(rect.bottom + PAD, vh - EDGE) - t };
      })()
    : null;

  return createPortal(
    <div className="fixed inset-0 z-[200]" role="dialog" aria-modal data-tour-card>
      <OverlayFlag />
      {step.kind !== "spotlight" && (
        <div className="absolute inset-0" style={{ background: step.kind === "chooseLayout" ? "rgba(6,10,20,0.4)" : SCRIM }} />
      )}
      {step.kind === "spotlight" && spotBox && (
        <div
          className="absolute rounded-[10px] border-2 border-blue-300 transition-all duration-300"
          style={{ left: spotBox.left, top: spotBox.top, width: spotBox.width, height: spotBox.height, boxShadow: `0 0 0 9999px ${SCRIM}, 0 0 26px rgba(96,165,250,0.4)` }}
        />
      )}

      {step.kind === "chooseLayout" && (
        <div ref={cardRef} className={`fixed z-[210] left-1/2 -translate-x-1/2 bottom-[6%] w-[500px] max-w-[calc(100vw-24px)] rounded-2xl ${surface} shadow-2xl p-5`}>
          {/* Live theme toggle — flips the whole app AND this card (they share the
              app's dark class), same set-your-preference spirit as the layout chooser. */}
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:border-slate-400 dark:hover:border-slate-500 transition"
          >
            {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <div className={`text-center ${kicker}`}>Cobblr</div>
          <h3 className="text-center text-lg font-bold">{step.title}</h3>
          <p className={`text-center text-sm mt-1.5 ${muted}`}>{step.body}</p>
          <div className="flex flex-col gap-2.5 mt-4">
            {LAYOUT_OPTIONS.map((o) => {
              const sel = navMode === o.id || (o.id === "top" && navMode === "top") || (o.id === "side" && navMode === "side");
              return (
                <button key={o.id} type="button" onClick={o.apply} className={"text-left rounded-xl border-2 p-3.5 transition " + (sel ? "border-blue-500 bg-blue-50 dark:bg-slate-800" : "border-slate-200 dark:border-slate-700 hover:border-blue-400")}>
                  <div className="font-bold text-[15px]">{o.label}</div>
                  <div className={`text-[13px] mt-1 leading-snug ${muted}`}>{o.desc}</div>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-center gap-3 mt-4">
            <button type="button" className={skip} onClick={onClose}>Skip tour</button>
            <button type="button" className={pri} onClick={() => move(1)} aria-keyshortcuts="ArrowRight">Take the tour <ArrowRight size={14} /></button>
          </div>
        </div>
      )}

      {step.kind === "spotlight" && (
        <div ref={cardRef} className={card} style={cardPos ? { left: cardPos.left, top: cardPos.top } : { left: "50%", top: "44%", transform: "translate(-50%,-50%)" }}>
          <h3 className="text-base font-bold">{step.title}</h3>
          <p className={`text-sm mt-1.5 leading-relaxed ${muted}`}>{step.body}</p>
          <div className="flex items-center gap-2 mt-3.5">
            <div className="flex gap-1.5 mr-auto">
              {Array.from({ length: spots }).map((_, n) => (
                <span key={n} className={"w-1.5 h-1.5 rounded-full " + (n + 1 === spotAt ? "bg-blue-500 dark:bg-blue-300" : "bg-slate-300 dark:bg-slate-600")} />
              ))}
            </div>
            <button type="button" className={skip} onClick={onClose}>Skip</button>
            <button type="button" className={ghost} onClick={() => move(-1)} aria-keyshortcuts="ArrowLeft"><ArrowLeft size={14} /> Back</button>
            <button type="button" className={pri} onClick={() => move(1)} aria-keyshortcuts="ArrowRight">Next <ArrowRight size={14} /></button>
          </div>
        </div>
      )}

      {step.kind === "done" && (
        <div ref={cardRef} className={`fixed z-[210] left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2 w-[380px] max-w-[calc(100vw-24px)] rounded-2xl ${surface} shadow-2xl p-5 text-center`}>
          <div className={kicker}>Cobblr</div>
          <h3 className="text-lg font-bold">{step.title}</h3>
          <p className={`text-sm mt-1.5 ${muted}`}>{step.body}</p>
          <div className="flex items-center justify-center gap-3 mt-4">
            <button type="button" className={ghost} onClick={() => move(-1)} aria-keyshortcuts="ArrowLeft"><ArrowLeft size={14} /> Back</button>
            <button type="button" className={pri} onClick={onClose}>Finish</button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
