// Is the camera actually delivering frames? — the check the freeze bug proved
// we need.
//
// The scanner already had a visibility-based recovery, and it still froze:
// after backgrounding, iOS Safari routinely hands the track back with
// readyState "live" and muted false while delivering NOTHING. Every gate that
// interrogates the track's claimed state passes on a dead stream. The only
// honest signal is frames actually arriving (requestVideoFrameCallback), so
// this watchdog counts those and re-acquires when they stop — which also
// covers lock/unlock, another app stealing the camera, bfcache restores that
// skip visibilitychange, and any future variant of "the track lies".
//
// Pure timestamp logic here (node-tested); the page feeds it frame events and
// asks "should I re-acquire?" from its decode loops.

/** No frame for this long, while playing and visible → the stream is dead. A
 *  healthy camera produces frames every ~33ms; 3s is far past any hiccup. */
export const STALL_MS = 3000;
/** Floor between re-acquire attempts, so a camera that won't come back is a
 *  retry every few seconds, not a getUserMedia storm. */
export const REACQUIRE_BACKOFF_MS = 10_000;

export interface FrameClock {
  lastFrameAt: number;
  lastReacquireAt: number;
}

export function frameClockInitial(now: number): FrameClock {
  // lastReacquireAt sits a full backoff in the past so the FIRST stall can
  // fire immediately — a fresh clock must not start inside its own backoff.
  return { lastFrameAt: now, lastReacquireAt: now - REACQUIRE_BACKOFF_MS };
}

/** A frame actually rendered. */
export function noteFrame(c: FrameClock, now: number): FrameClock {
  return { ...c, lastFrameAt: now };
}

/** Playback resumed (sheet closed, tab returned). Resets the grace window so
 *  a clock that went stale while DELIBERATELY paused can't insta-fire against
 *  a healthy stream — the stream gets STALL_MS to produce its first frame. */
export function noteResume(c: FrameClock, now: number): FrameClock {
  return { ...c, lastFrameAt: now };
}

/** Called from the decode loops (only while playing + visible). True means
 *  bump the stream epoch — and the clock is reset so the verdict fires once
 *  per stall, with backoff between attempts. */
export function shouldReacquire(
  c: FrameClock,
  now: number,
): { fire: boolean; clock: FrameClock } {
  if (now - c.lastFrameAt < STALL_MS) return { fire: false, clock: c };
  if (now - c.lastReacquireAt < REACQUIRE_BACKOFF_MS) return { fire: false, clock: c };
  return { fire: true, clock: { lastFrameAt: now, lastReacquireAt: now } };
}
