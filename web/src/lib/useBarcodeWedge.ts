import { useEffect, useRef, type RefObject } from "react";
import {
  CTRL_CHORD_CHARS,
  createWedgeDetector,
  type WedgeConfig,
  type WedgeDetector,
} from "./barcode-wedge";

const formWedgeEvents = new WeakSet<KeyboardEvent>();

/** Is the keystroke landing in something the user is actively typing into? If
 *  so, leave it alone — the wedge must never steal input from the UPC field, a
 *  search box, or any form. (A focused scanner-into-an-input flow already works
 *  the normal way; the wedge is for the *hands-free*, nothing-focused case.) */
function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable;
}

export interface UseBarcodeWedgeOptions {
  /** Turn the listener on/off (e.g. only on the Scan page). */
  enabled?: boolean;
  /** Called with the decoded barcode when a hardware scan completes. */
  onScan: (code: string) => void;
  /** Override the burst-detection tuning. */
  config?: WedgeConfig;
  formScope?: RefObject<HTMLElement | null>;
}

/**
 * Listen document-wide for a hardware barcode scanner (HID keyboard wedge) and
 * fire `onScan` with the decoded value — no input focus required. Keystrokes
 * aimed at a real input/textarea/select are passed through untouched.
 *
 * `onScan` is held in a ref so the effect doesn't re-bind every render — callers
 * can pass an inline closure without it tearing down the listener mid-scan.
 */
export function useBarcodeWedge({ enabled = true, onScan, config, formScope }: UseBarcodeWedgeOptions): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const detector: WedgeDetector = createWedgeDetector(config ?? (formScope ? { maxAvgPerKeyMs: 35, maxPauseMs: 500, minLength: 8, terminators: ["Enter", "Tab"] } : undefined));
    let snapshot: { el: HTMLInputElement | HTMLTextAreaElement; value: string; start: number | null; end: number | null } | null = null;
    let target: EventTarget | null = null;

    const handler = (e: KeyboardEvent) => {
      if (!formScope && formWedgeEvents.has(e)) { detector.reset(); return; }
      if (formScope) {
        const container = formScope.current?.closest("form");
        if (!container || !(e.target instanceof Node) || !container.contains(e.target)) { detector.reset(); snapshot = null; return; }
        formWedgeEvents.add(e);
      }
      // Don't compete with a field the user is typing into.
      // AltGraph produces printable characters on some scanner layouts.
      const now = performance.now();
      if (formScope && (target !== e.target || !detector.inBurst(now))) {
        detector.reset();
        target = e.target;
        snapshot = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
          ? { el: e.target, value: e.target.value, start: e.target.selectionStart, end: e.target.selectionEnd } : null;
      }
      // A scanner sends the control characters a reel label carries as Ctrl
      // chords (Ctrl+] is GS). Inside a scanner burst they are payload, never
      // a shortcut: kept for the parser, and the browser's own Ctrl+D never
      // fires mid-scan. Outside a burst a Ctrl chord is a person's shortcut.
      const chord = e.ctrlKey && !e.altKey && !e.metaKey ? CTRL_CHORD_CHARS[e.key] : undefined;
      if (chord && !isEditableTarget(e.target) && detector.inBurst(now)) {
        e.preventDefault();
        detector.feed(chord, now);
        return;
      }
      const shortcut = !e.getModifierState("AltGraph") && (e.ctrlKey || e.metaKey || e.altKey);
      if ((!formScope && isEditableTarget(e.target)) || shortcut) {
        detector.reset();
        return;
      }
      const code = detector.feed(e.key, now);
      if (code) {
        // Swallow the trailing Enter so it can't also trigger something else.
        e.preventDefault();
        if (formScope) {
          e.stopImmediatePropagation();
          if (snapshot) {
            const { el, value, start, end } = snapshot;
            const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(el, value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            if (start != null && end != null) el.setSelectionRange(start, end);
          }
          snapshot = null;
        }
        onScanRef.current(code);
      }
    };

    document.addEventListener("keydown", handler, !!formScope);
    return () => {
      document.removeEventListener("keydown", handler, !!formScope);
      detector.reset();
    };
  }, [enabled, config, formScope]);
}
