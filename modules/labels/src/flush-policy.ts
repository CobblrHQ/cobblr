// Accumulate-then-print: the pure decision of WHEN a buffered print queue fires,
// and how a partial last sheet behaves (D5 + D6 of
// docs/design-decisions/label-media-and-accumulation.md). No I/O and no DB, so it
// is unit-testable against every scenario; slice 2b wires it into the queue-insert
// path and the per-printer policy.

/** The fire rule a printer (or a scan session override) carries.
 *  - manual     never auto-fires; a "print now" button flushes the buffer.
 *  - fill-media fire a full sheet once the buffer reaches `tiles`.
 *  - count      fire `count` items once the buffer reaches it (may span/partial a sheet).
 *  - immediate  fire per capture: one tile now, the rest of the sheet per D6. */
export type FireMode = "manual" | "fill-media" | "count" | "immediate";

export interface FlushPolicy {
  mode: FireMode;
  /** items per fire for `count` mode; ignored otherwise. */
  count?: number;
}

export interface FlushDecision {
  /** How many buffered items to flush into a print NOW. 0 = do not auto-fire. */
  flush: number;
  /** Blank tiles on the last (partial) sheet. Only fixed-position media
   *  (die-cut / sheet) wastes tiles; a continuous roll feeds only what's used. */
  blanks: number;
}

const NONE: FlushDecision = { flush: 0, blanks: 0 };

/** Blanks left on the final sheet when `items` are laid onto `tiles`-per-sheet
 *  media. Zero for continuous (no fixed positions) or an exact fill. */
export function trailingBlanks(items: number, tiles: number, fixedPositions: boolean): number {
  const t = Math.max(1, Math.floor(tiles));
  if (!fixedPositions || items <= 0) return 0;
  const rem = items % t;
  return rem === 0 ? 0 : t - rem;
}

/** The auto-flush decision to run on each queue insert. `buffered` items are
 *  waiting; `tiles` fit one sheet of the chosen size; `fixedPositions` is true for
 *  die-cut / sheet media (a partial sheet leaves blanks) and false for a
 *  continuous roll (feed only what's used). */
export function flushDecision(
  buffered: number,
  tiles: number,
  policy: FlushPolicy,
  opts: { fixedPositions: boolean },
): FlushDecision {
  const t = Math.max(1, Math.floor(tiles));
  const buf = Math.max(0, Math.floor(buffered));
  switch (policy.mode) {
    case "manual":
      return NONE;
    case "immediate": {
      // one label now, don't wait to tile the rest (scenario E).
      if (buf < 1) return NONE;
      return { flush: 1, blanks: trailingBlanks(1, t, opts.fixedPositions) };
    }
    case "fill-media": {
      // a whole sheet at a time; leftover keeps buffering (scenario A/D).
      if (buf < t) return NONE;
      return { flush: t, blanks: 0 };
    }
    case "count": {
      // fire exactly `count` once reached; it may under- or over-fill a sheet
      // (scenario B/B'). Leftover past `count` re-evaluates on the next insert.
      const m = Math.max(1, Math.floor(policy.count ?? t));
      if (buf < m) return NONE;
      return { flush: m, blanks: trailingBlanks(m, t, opts.fixedPositions) };
    }
  }
}

/** A deliberate "print now" flush of the whole buffer (the manual button, always
 *  available). Flushes everything; a partial last sheet blanks per the media. */
export function manualFlush(buffered: number, tiles: number, fixedPositions: boolean): FlushDecision {
  const buf = Math.max(0, Math.floor(buffered));
  if (buf < 1) return NONE;
  return { flush: buf, blanks: trailingBlanks(buf, tiles, fixedPositions) };
}
