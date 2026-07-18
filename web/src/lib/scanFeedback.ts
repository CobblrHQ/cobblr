// Audible scan confirmation. navigator.vibrate is the primary cue on Android
// and does not exist on iOS Safari — so on the flagship scanning device every
// hit was completely silent. Each cue point plays a short low-volume WebAudio
// blip alongside the vibration attempt.
//
// iOS gates audio behind a user gesture: armScanAudio() creates the context at
// mount and re-resumes it on the first pointer/touch interaction, so by the
// time a code is in frame the context is running and beeps are audible.

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
}

/** Create the audio context and keep resuming it on user gestures. Returns cleanup. */
export function armScanAudio(): () => void {
  const c = audioCtx();
  if (!c) return () => {};
  const resume = () => {
    if (c.state === "suspended") void c.resume().catch(() => {});
  };
  resume();
  window.addEventListener("pointerdown", resume, { passive: true });
  window.addEventListener("touchend", resume, { passive: true });
  return () => {
    window.removeEventListener("pointerdown", resume);
    window.removeEventListener("touchend", resume);
  };
}

export type BeepKind = "scan" | "confirm" | "shutter";

/** Short quiet blip. Best-effort: never throws, silently skips when audio is locked. */
export function scanBeep(kind: BeepKind): void {
  const c = audioCtx();
  if (!c || c.state !== "running") return;
  try {
    const t0 = c.currentTime;
    // [frequency Hz, offset s, duration s] — confirm is an ascending pair so a
    // sort "Done" is distinguishable from the next item's scan blip by ear.
    const notes: Array<[number, number, number]> =
      kind === "confirm"
        ? [
            [988, 0, 0.06],
            [1319, 0.07, 0.09],
          ]
        : kind === "shutter"
          ? [[1568, 0, 0.05]]
          : [[880, 0, 0.08]];
    for (const [freq, at, dur] of notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.06, t0 + at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + dur + 0.02);
    }
  } catch {
    // Audio is a nicety — a beep failure must never interfere with the scan.
  }
}
