// Hardware barcode-scanner support: a "keyboard wedge" detector.
//
// A USB/Bluetooth barcode scanner (1D laser or 2D imager) is, to the OS, just a
// HID KEYBOARD. It "types" the decoded value one keystroke at a time and then
// presses Enter — there is no special browser API to talk to, no driver, no
// pairing beyond plugging it in. The whole job on our side is telling a *scanner
// burst* apart from a *human typing*:
//
//   · a scanner fires characters far faster than fingers — typically <30ms
//     apart, and never slower than ~50ms even for a cheap one;
//   · it ends the code with a terminator key (Enter by default on virtually
//     every scanner; some send Tab).
//
// So we buffer keystrokes that arrive within `maxInterKeyMs` of each other and,
// on a terminator, emit the buffer IF it arrived fast enough and is long enough
// to be a real code. A slow human keypress resets the buffer, so ordinary typing
// never trips it. This is a PURE state machine — no DOM, no clock — so it unit-
// tests deterministically by feeding explicit timestamps. The React hook
// (`useBarcodeWedge`) wraps it with a real `document` listener + `performance.now()`.
//
// 1D vs 2D is invisible here: both kinds emit keystrokes the same way (2D just
// carries QR/DataMatrix/PDF417 instead of UPC/EAN/Code-128). The camera scanner
// (`barcodeScanner.ts`) is the other intake; this is the hands-free hardware one.

export interface WedgeConfig {
  /** Max gap between two keystrokes to still count as one scanner burst (ms). */
  maxInterKeyMs: number;
  /** Shortest plausible barcode — drops stray single keys + accidental Enters. */
  minLength: number;
  /** Keys that end a scan. Scanners send Enter by default; some send Tab. */
  terminators: string[];
}

export const DEFAULT_WEDGE_CONFIG: WedgeConfig = {
  // 50ms is comfortably above any scanner's inter-key gap yet far below human
  // typing (~120ms+ between keys even when fast), so the two never overlap.
  maxInterKeyMs: 50,
  minLength: 3,
  terminators: ["Enter", "Tab"],
};

export interface WedgeDetector {
  /**
   * Feed one keydown. `key` is the KeyboardEvent.key; `now` is a monotonic ms
   * timestamp (performance.now() in the browser, explicit in tests). Returns the
   * completed code string when a terminator closes a valid burst, else null.
   */
  feed(key: string, now: number): string | null;
  /** Drop any in-progress buffer (e.g. on blur). */
  reset(): void;
}

/** Is `key` a single printable character (a barcode payload char)? */
function isPrintable(key: string): boolean {
  return key.length === 1;
}

export function createWedgeDetector(
  config: WedgeConfig = DEFAULT_WEDGE_CONFIG,
): WedgeDetector {
  let buffer = "";
  let lastAt = 0;

  const reset = () => {
    buffer = "";
    lastAt = 0;
  };

  return {
    reset,
    feed(key, now) {
      if (config.terminators.includes(key)) {
        // A terminator only completes a code if the burst is fast AND long
        // enough — a lone Enter (buffer empty) or a slow one is just a keypress.
        const fast = buffer.length > 0 && now - lastAt <= config.maxInterKeyMs;
        const code = fast && buffer.length >= config.minLength ? buffer : null;
        reset();
        return code;
      }

      if (!isPrintable(key)) {
        // Modifiers, arrows, Backspace, etc. aren't part of a scanner payload —
        // their presence means a human is at the keyboard, so abandon the burst.
        reset();
        return null;
      }

      // A gap longer than the burst window means this char starts fresh — it's
      // either the first char of a scan or a human typing (which won't keep up).
      if (buffer.length > 0 && now - lastAt > config.maxInterKeyMs) {
        buffer = "";
      }
      buffer += key;
      lastAt = now;
      return null;
    },
  };
}
