// Hardware barcode-scanner support: a "keyboard wedge" detector.
//
// A USB/Bluetooth barcode scanner (1D laser or 2D imager) is, to the OS, just a
// HID KEYBOARD. It "types" the decoded value one keystroke at a time and then
// presses Enter — there is no special browser API to talk to, no driver, no
// pairing beyond connecting it. The whole job on our side is telling a *scanner
// burst* apart from a *human typing*:
//
//   · a scanner fires a whole code far faster than fingers can — even a cheap
//     Bluetooth one averages well under ~100ms PER CHARACTER across the code;
//   · it ends the code with a terminator key (Enter by default on virtually
//     every scanner; some send Tab).
//
// We judge the burst by its WHOLE-CODE AVERAGE rate, not the gap between any two
// keys. That matters because a **Bluetooth** scanner's keystrokes arrive with
// real jitter — the OS/BT stack batches and delays them, so individual gaps can
// momentarily spike well past a USB dongle's steady <30ms. An older per-key-gap
// rule (reset the buffer whenever two keys land >50ms apart) therefore kept
// breaking BT bursts mid-code so they never completed — the bug this fixes. The
// average smooths the jitter out: scanners still come in far under the threshold,
// sustained human typing (~120ms+/char) stays far above it, and a human-length
// PAUSE mid-burst starts a fresh code. Pure state machine — no DOM, no clock — so
// it unit-tests deterministically by feeding explicit timestamps. The React hook
// (`useBarcodeWedge`) wraps it with a real `document` listener + `performance.now()`.
//
// 1D vs 2D is invisible here: both kinds emit keystrokes the same way (2D just
// carries QR/DataMatrix/PDF417 instead of UPC/EAN/Code-128). The camera scanner
// (`barcodeScanner.ts`) is the other intake; this is the hands-free hardware one.

export interface WedgeConfig {
  /** The whole code's AVERAGE inter-character time must be at most this (ms).
   *  Scanners run ~10–80ms/char even over Bluetooth; sustained human typing
   *  rarely beats ~100ms/char — so the average cleanly separates them, and
   *  unlike a per-key gap it tolerates a BT scanner's mid-burst jitter. */
  maxAvgPerKeyMs: number;
  /** A single gap longer than this means a human paused: start a fresh code (and
   *  a terminator arriving this long after the last char is stale). Generous on
   *  purpose — even if a human's pause slips under it, the average still rejects
   *  them; the job here is only to not concatenate two unrelated bursts. */
  maxPauseMs: number;
  /** Shortest plausible barcode — drops stray single keys + accidental Enters. */
  minLength: number;
  /** Keys that end a scan. Scanners send Enter by default; some send Tab. */
  terminators: string[];
}

export const DEFAULT_WEDGE_CONFIG: WedgeConfig = {
  // 130ms/char average sits comfortably above any scanner (USB or Bluetooth,
  // which is slower + jittery) yet below sustained human typing. We err generous:
  // the wedge only runs with NO input focused (humans don't type barcodes on the
  // bare page), so a too-tight threshold silently drops real scans (the BT bug)
  // while a too-loose one at worst makes a dismissable inbox item.
  maxAvgPerKeyMs: 130,
  // ~half a second with no key = a human paused / two separate bursts.
  maxPauseMs: 500,
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

/** Modifier keys a scanner emits WHILE typing a payload char (Shift for an
 *  uppercase letter, etc.) — ignored, not treated as a human interrupting. */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "AltGraph",
  "NumLock",
  "Dead",
]);

export function createWedgeDetector(
  config: WedgeConfig = DEFAULT_WEDGE_CONFIG,
): WedgeDetector {
  let buffer = "";
  let firstAt = 0;
  let lastAt = 0;

  const reset = () => {
    buffer = "";
    firstAt = 0;
    lastAt = 0;
  };

  return {
    reset,
    feed(key, now) {
      if (config.terminators.includes(key)) {
        // Complete a code only if it's long enough, the terminator didn't arrive
        // after a human-length pause, and the WHOLE burst averaged scanner-fast.
        // The average (not any single gap) is what makes a jittery Bluetooth
        // scanner work — a lone Enter (empty buffer) or a slow burst is ignored.
        const stale = buffer.length === 0 || now - lastAt > config.maxPauseMs;
        const fastEnough =
          buffer.length >= config.minLength &&
          now - firstAt <= buffer.length * config.maxAvgPerKeyMs;
        const code = !stale && fastEnough ? buffer : null;
        reset();
        return code;
      }

      // Modifier keys ACCOMPANY a scanner's printable chars rather than interrupt
      // them: a scanner presses Shift to type an uppercase letter (Amazon/ASIN-
      // style alphanumeric codes like "X004PV2T2X"), and CapsLock/AltGraph/Dead
      // for others. Ignore them — don't reset — so the real character lands on the
      // next keydown. Resetting here silently dropped EVERY code with a capital
      // (numeric UPCs need no Shift, so those always worked, masking the bug).
      if (MODIFIER_KEYS.has(key)) return null;

      if (!isPrintable(key)) {
        // A real navigation/edit key (arrows, Backspace, Home, …) means a human is
        // at the keyboard, not a scanner burst — abandon it.
        reset();
        return null;
      }

      // A pause longer than a human's between two chars means this char starts a
      // fresh code — don't prepend a stale buffer to a new scan.
      if (buffer.length > 0 && now - lastAt > config.maxPauseMs) {
        buffer = "";
        firstAt = 0;
      }
      if (buffer.length === 0) firstAt = now;
      buffer += key;
      lastAt = now;
      return null;
    },
  };
}
