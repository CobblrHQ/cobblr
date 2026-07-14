// Should a raw barcode/QR sighting FIRE a scan, or is it noise?
//
// Two jobs, both about not firing too eagerly:
//   1. AGREEMENT GATE — require the same code on two consecutive sightings before
//      accepting. The native BarcodeDetector loop runs every animation frame, and
//      a single frame can misread a barcode that isn't even in view; two-in-a-row
//      throws those away.
//   2. CONTINUOUS-PRESENCE DEDUP — a code HELD in the frame is ONE scan, not many.
//      A QR held at a location used to re-fire (and re-toast "Filing into…") every
//      couple of seconds, because the old guard measured time since we last ACTED
//      and never refreshed while the code stayed in view. Here the sighting time
//      is refreshed on every frame; `acted` records that we've handled this
//      continuous presence. Held steady → suppressed forever. It only re-scans
//      after the code LEAVES the frame for `repeatGapMs` (a gap in sightings
//      clears `acted`) and returns — the deliberate "scan it again" gesture.
//
// Pure and unit-tested. The component owns the mutable state (a ref) and the side
// effects; this decides yes/no. Extracted after a re-arm bug slipped through by
// eye: refreshing the timestamp on the return frame made the NEXT frame read as
// "still held" and suppress forever, so a code that left and came back never
// re-fired. That's exactly the kind of off-by-one a test pins down.

export interface DedupState {
  /** The last code we ACCEPTED, and when it was last seen in view. */
  seen: { value: string; at: number; acted: boolean } | null;
  /** The current agreement-gate candidate (a code seen once, awaiting a second). */
  candidate: { value: string; count: number } | null;
}

export function freshDedupState(): DedupState {
  return { seen: null, candidate: null };
}

/**
 * Feed one sighting. MUTATES `state` (it mirrors the component's refs) and returns
 * true when this sighting should fire a scan.
 *
 * @param repeatGapMs how long a code must be ABSENT before it counts as new.
 */
export function shouldFireScan(
  state: DedupState,
  raw: string,
  now: number,
  repeatGapMs: number,
): boolean {
  const code = raw.trim();
  if (!code) return false;

  // Continuous-presence dedup, keyed on the last ACCEPTED code.
  const seen = state.seen;
  if (seen && seen.value === code) {
    if (now - seen.at >= repeatGapMs) seen.acted = false; // it left the frame + came back
    seen.at = now; // keep the sighting time alive while it's in view
    if (seen.acted) {
      state.candidate = null;
      return false;
    }
  }

  // Agreement gate: two consecutive identical sightings.
  const cand = state.candidate;
  if (cand && cand.value === code) {
    cand.count += 1;
  } else {
    state.candidate = { value: code, count: 1 };
    return false;
  }
  if (cand.count < 2) return false;

  state.candidate = null;
  state.seen = { value: code, at: now, acted: true };
  return true;
}
