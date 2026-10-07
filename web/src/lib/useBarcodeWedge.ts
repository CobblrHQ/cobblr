import { useEffect, useRef } from "react";
import {
  CTRL_CHORD_CHARS,
  createWedgeDetector,
  type WedgeConfig,
  type WedgeDetector,
} from "./barcode-wedge";

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
}

/**
 * Listen document-wide for a hardware barcode scanner (HID keyboard wedge) and
 * fire `onScan` with the decoded value — no input focus required. Keystrokes
 * aimed at a real input/textarea/select are passed through untouched.
 *
 * `onScan` is held in a ref so the effect doesn't re-bind every render — callers
 * can pass an inline closure without it tearing down the listener mid-scan.
 */
export function useBarcodeWedge({ enabled = true, onScan, config }: UseBarcodeWedgeOptions): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const detector: WedgeDetector = createWedgeDetector(config);

    const handler = (e: KeyboardEvent) => {
      // Don't compete with a field the user is typing into.
      // AltGraph produces printable characters on some scanner layouts.
      const now = performance.now();
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
      if (isEditableTarget(e.target) || shortcut) {
        detector.reset();
        return;
      }
      const code = detector.feed(e.key, now);
      if (code) {
        // Swallow the trailing Enter so it can't also trigger something else.
        e.preventDefault();
        onScanRef.current(code);
      }
    };

    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      detector.reset();
    };
  }, [enabled, config]);
}
