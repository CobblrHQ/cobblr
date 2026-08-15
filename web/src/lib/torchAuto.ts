// Auto-torch: "I can see you're trying to scan in the dark, let me help" —
// without ever strobing.
//
// The naive version strobes by construction: torch brightens the frame →
// "lighting improved" → torch off → dark again → on. The load-bearing rule
// here is that AMBIENT IS ONLY MEASURED WHILE THE TORCH IS OFF. Once on, dark
// votes stop entirely; the torch turns off only on discrete events — a hard
// bright scene held for a while (you walked into a lit room), a runtime cap
// (then a cooldown before it may re-fire), or the page's own lifecycle
// (sheet open / scan success / close), which calls release().
//
// WHY BRIGHTNESS CANNOT ANSWER "is the room lit again?" (from ?diag=1,
// 2026-08-05): with the torch on, a BRIGHT room read mean luma 121 — the same
// value a torch-lit DARK room reads. iOS auto-exposure drives the frame to a
// target level, so once there is enough light for AE to work with, overall
// brightness says nothing about ambient. Two thresholds died on this (a fixed
// near-saturation 230, then a torch-lit-baseline + margin).
//
// The exposure-invariant signal is the torch's FALLOFF: a torch in a dark room
// lights the centre far more than the edges (a hotspot), while ambient light is
// even. AE scales the whole frame, so it cancels out of the centre/edge RATIO.
// Room lights coming on collapses that ratio toward 1 even though the mean
// never moves. That is the primary off-signal here.
//
// The backstop for the ambiguous case (a close, evenly torch-lit box) is
// honest rather than clever: the burn is capped, and the OFF at the cap is
// itself the ambient probe — with the torch off, mean luma is meaningful
// again, so a still-dark room re-fires in ~3s and a lit room simply stays off.
// A brief dip every burn window is the price of not lying; it is not a strobe.
//
// AND the burn must be FOR something (reported 2026-08-05: phone dangling at waist
// height, camera at the floor, "the auto-flash turns on then - that's
// unexpected and annoying"). Dark alone can't distinguish a dark shelf from a
// dark floor — but what the torch REVEALS can: light a shelf and the
// orientation estimator finds code-like structure; light a floor and it finds
// nothing. A burn that reveals nothing code-like within a few seconds was
// pointless, so it ends and auto is SUPPRESSED until the scene meaningfully
// changes (the frame-difference spike of the phone being raised), at which
// point the dark-dwell trigger is live again.
//
// AND THE TRIGGER IS A FAILING SCAN, NOT A DARK ROOM (reported 2026-08-14:
// "auto-on flash is coming on too frequently... there are times that the light
// is needed to be able to scan a barcode, but I end up just turning it on
// manually now"). The rule above only ever ended a bad burn after it had
// already started; darkness still began one, and darkness is common and mostly
// harmless. So the same structure evidence now drives the ON side too, in two
// grades:
//
//   STRUGGLING — a code-like region is in view and no read is landing, in a
//     scene dim enough that light is a plausible cause. That is precisely when
//     a human reaches for the torch button, so it fires fast.
//   DARK ONLY — no structure evidence, just a dark frame. Weak: it describes a
//     dark floor as readily as a dark shelf. It still fires, because a room can
//     be too dark for the estimator to find anything at all and that is the
//     case the torch exists for, but it must hold for much longer first.
//
// A decode loop that cannot measure structure only ever reaches the patient
// grade, so it is strictly less eager than before and never more.
//
// Pure state machine: samples in, "turn the torch on/off" intents out. The
// canvas glue (sampling luma + falloff off the live video) sits at the bottom;
// everything above it is node-testable, and the strobe case is pinned in
// torchAuto.test.ts.

export interface TorchAutoConfig {
  /** Mean luma (0-255) below which the scene counts as dark. */
  darkLuma: number;
  /** Dark ALONE must hold this long before the torch fires. Long on purpose: a
   *  dark frame with nothing code-like in it is the weakest reason to fire, and
   *  at the old 900ms every glance at a dark surface lit the room. A scene that
   *  is genuinely too dark to scan stays dark, so it still gets there. */
  darkDwellMs: number;
  /** Luma below which a code-like region that WON'T decode is plausibly a light
   *  problem. Higher than darkLuma: a barcode in shadow, or a low-contrast one
   *  under weak light, reads far above "dark" and is exactly the case people
   *  hit the torch button for. Above this, light is not what's missing. */
  dimLuma: number;
  /** ...and how long that struggle must hold. Short: unlike a dark frame, this
   *  is direct evidence of a scan that is trying and failing. */
  strugglingDwellMs: number;
  /** While ON: absolute saturation — this bright means improved regardless of
   *  any baseline. */
  brightLuma: number;
  /** ...held this long (applies to both bright-off conditions). */
  brightDwellMs: number;
  /** After firing, wait this long before capturing the torch-lit BASELINE —
   *  the camera's auto-exposure needs a beat to settle. */
  baselineSettleMs: number;
  /** ...then average samples over this window (a single sample could land on
   *  a still-dark or glare frame and skew the baseline for the whole burn). */
  baselineCaptureMs: number;
  /** "Lighting improved" = the scene climbing this far above the torch-lit
   *  baseline. The torch's own steady contribution is IN the baseline, so
   *  only genuine ambient change can cross it. (The first version used a
   *  fixed near-saturation 230 instead — unreachable in a normal room, so
   *  the flash just stayed on. reported 2026-08-05.) */
  brightMargin: number;
  /** ...but never treat anything below this as "bright" (a dim torch-lit
   *  scene plus margin could otherwise sit absurdly low). */
  brightOffFloor: number;
  /** PRIMARY off-signal: the torch-lit falloff (centre/edge) collapsing to
   *  this FRACTION of its baseline means ambient light took over. Exposure
   *  invariant, so it works where every brightness threshold failed. */
  falloffCollapse: number;
  /** Falloff is only trustworthy when the torch actually made a hotspot; a
   *  baseline this flat means the geometry can't answer (a close, evenly lit
   *  box) and only the cap probe decides. */
  falloffBaselineMin: number;
  /** A dark re-fire soon after a bright-off means the off was WRONG (a
   *  reflective surface, not a brighter room) — raise the margin by this
   *  much so the same surface can't oscillate the torch. */
  boostStep: number;
  boostMax: number;
  /** How soon after a bright-off a dark re-fire counts as "that off was wrong". */
  refireWindowMs: number;
  /** A burn that has revealed nothing code-like for this long was pointless
   *  (a dark floor, not a dark shelf) — end it and suppress. Only evaluated
   *  when the caller supplies structure evidence at all. */
  fruitlessMs: number;
  /** Scene-change (mean absolute frame difference, 0-255) that ends a
   *  fruitless suppression — the phone being raised is a large one; a static
   *  dangle is ~0. */
  rearmSceneDelta: number;
  /** Suppression safety valve: after this long, re-arm regardless. */
  rearmMaxMs: number;
  /** Max continuous ON before the cap probe re-evaluates ambient (also the
   *  battery + heat bound). Short enough that a lit room never keeps the
   *  light for long, long enough that the probe dip is rare. */
  capMs: number;
  /** Cooldown after a CAP off. Deliberately short: this off exists to sample
   *  ambient with the torch out of the way, so a still-dark room should get
   *  its light back promptly rather than scanning dark for 8s. */
  probeCooldownMs: number;
  /** After ANY off, wait this long before the torch may re-fire. This is the
   *  anti-strobe floor: worst case is one blink per cooldown, not a flicker. */
  cooldownMs: number;
}

export const TORCH_AUTO_DEFAULTS: TorchAutoConfig = {
  darkLuma: 50,
  darkDwellMs: 2500,
  dimLuma: 110,
  strugglingDwellMs: 900,
  brightLuma: 230,
  brightDwellMs: 2000,
  baselineSettleMs: 800,
  baselineCaptureMs: 2000,
  brightMargin: 60,
  brightOffFloor: 120,
  falloffCollapse: 0.62,
  falloffBaselineMin: 1.35,
  boostStep: 40,
  boostMax: 160,
  refireWindowMs: 20_000,
  fruitlessMs: 3500,
  rearmSceneDelta: 16,
  rearmMaxMs: 180_000,
  capMs: 20_000,
  probeCooldownMs: 1500,
  cooldownMs: 8000,
};

/** One frame's measurements. `falloff` is centre mean / edge mean — ~1 under
 *  even light, well above 1 when the torch is making a hotspot. */
export interface LumaSample {
  mean: number;
  falloff: number;
  /** Did the frame contain code-like structure (the orientation estimator
   *  located a stripe region)? Omit when unknown — the fruitless rule and the
   *  eager ON grade then both stay out of the way entirely, leaving the
   *  patient dark rule and the plain cap.
   *
   *  While the torch is OFF this is read as "seen but unread": the sample loop
   *  only runs while actively scanning, and a frame that DECODED ends the scan,
   *  so a region that keeps being located without a read is a scan in trouble. */
  structure?: boolean;
  /** Mean absolute difference vs the previous sampled frame (0-255). Omit
   *  when unknown. */
  sceneDelta?: number;
}

export interface TorchAutoState {
  on: boolean;
  /** When the scene started asking for light — by either grade. Not "dark
   *  since": a struggling read in a merely dim scene starts this clock too. */
  wantSince: number | null;
  brightSince: number | null;
  onAt: number | null;
  cooldownUntil: number;
  /** Steady-state torch-lit luma, captured once AE settles after firing. */
  onBaseline: number | null;
  /** ...and the torch's falloff at that moment — the reference the collapse
   *  test measures against. */
  onFalloff: number | null;
  /** Session-learned addition to brightMargin (see boostStep). */
  marginBoost: number;
  lastBrightOffAt: number;
  /** While ON: has any sample shown code-like structure this burn? */
  sawStructure: boolean;
  /** A fruitless burn ended; the dark trigger is dead until the scene changes
   *  (or rearmMaxMs passes). 0 = not suppressed. */
  suppressedAt: number;
}

export function torchAutoInitial(): TorchAutoState {
  return {
    on: false,
    wantSince: null,
    brightSince: null,
    onAt: null,
    cooldownUntil: 0,
    onBaseline: null,
    onFalloff: null,
    marginBoost: 0,
    lastBrightOffAt: 0,
    sawStructure: false,
    suppressedAt: 0,
  };
}

export type TorchTurn = "on" | "off" | null;

/** Feed one frame's measurements; get back the next state and (rarely) an
 *  intent. A bare number is accepted as "mean only, no falloff geometry". */
export function torchAutoSample(
  s: TorchAutoState,
  sample: LumaSample | number,
  now: number,
  cfg: TorchAutoConfig = TORCH_AUTO_DEFAULTS,
): { state: TorchAutoState; turn: TorchTurn } {
  const luma = typeof sample === "number" ? sample : sample.mean;
  const falloff = typeof sample === "number" ? null : sample.falloff;
  const structure = typeof sample === "number" ? undefined : sample.structure;
  const sceneDelta = typeof sample === "number" ? undefined : sample.sceneDelta;
  if (!s.on) {
    // A fruitless-burn suppression lifts on a real scene change (the phone
    // being raised) or after the safety valve.
    let suppressedAt = s.suppressedAt;
    if (suppressedAt > 0) {
      const sceneChanged = sceneDelta !== undefined && sceneDelta >= cfg.rearmSceneDelta;
      if (sceneChanged || now - suppressedAt >= cfg.rearmMaxMs) suppressedAt = 0;
    }
    if (suppressedAt !== s.suppressedAt) s = { ...s, suppressedAt };
    if (s.suppressedAt > 0) {
      return { state: { ...s, wantSince: null }, turn: null };
    }
    // Two grades of "light would help", and they want very different patience.
    // Struggling is direct evidence (a code is right there and won't read);
    // dark alone is circumstantial, so it has to persist.
    const struggling = structure === true && luma < cfg.dimLuma;
    if (!struggling && luma >= cfg.darkLuma) {
      return { state: { ...s, wantSince: null }, turn: null };
    }
    const wantSince = s.wantSince ?? now;
    // The clock is shared, so a scene that was merely dark and then starts
    // struggling gets credit for the waiting it already did.
    const dwell = struggling ? cfg.strugglingDwellMs : cfg.darkDwellMs;
    if (now - wantSince >= dwell && now >= s.cooldownUntil) {
      // Re-firing right after a bright-off means that off was wrong — the
      // "brightness" was the torch bouncing off something reflective. Raise
      // the margin so the same surface can't cycle the torch again.
      const wrongOff = s.lastBrightOffAt > 0 && now - s.lastBrightOffAt <= cfg.refireWindowMs;
      const marginBoost = wrongOff
        ? Math.min(cfg.boostMax, s.marginBoost + cfg.boostStep)
        : s.marginBoost;
      return {
        state: {
          ...s,
          on: true,
          wantSince: null,
          brightSince: null,
          onAt: now,
          onBaseline: null,
          onFalloff: null,
          marginBoost,
          sawStructure: false,
        },
        turn: "on",
      };
    }
    return { state: { ...s, wantSince }, turn: null };
  }

  // ON: track whether this burn has revealed anything code-like.
  if (structure === true && !s.sawStructure) s = { ...s, sawStructure: true };
  // A burn that lit the scene and found nothing to scan was pointless — end
  // it and stay quiet until the scene changes. Only when the caller supplies
  // structure evidence at all (structure !== undefined); a loop that cannot
  // measure it keeps the plain cap behaviour.
  if (
    structure !== undefined &&
    !s.sawStructure &&
    s.onAt !== null &&
    now - s.onAt >= cfg.fruitlessMs
  ) {
    return {
      state: { ...s, ...offReset(), cooldownUntil: now + cfg.cooldownMs, suppressedAt: now },
      turn: "off",
    };
  }
  // The torch pollutes any absolute ambient read, so "lighting improved"
  // is judged RELATIVE to the torch-lit baseline captured after AE settles.
  if (s.onAt !== null && now - s.onAt >= cfg.capMs) {
    // The cap off IS the ambient probe: with the torch out of the way, mean
    // luma means something again. Short cooldown so a still-dark room gets
    // its light back promptly; a lit room simply never re-fires.
    return {
      state: { ...s, ...offReset(), cooldownUntil: now + cfg.probeCooldownMs },
      turn: "off",
    };
  }
  const settleEnd = (s.onAt ?? now) + cfg.baselineSettleMs;
  if (now < settleEnd) return { state: s, turn: null };
  let onBaseline = s.onBaseline;
  let onFalloff = s.onFalloff;
  if (now < settleEnd + cfg.baselineCaptureMs) {
    // Capture window: blend samples into the baselines; only the saturation
    // rule can turn the torch off while they are still forming.
    onBaseline = onBaseline === null ? luma : (onBaseline + luma) / 2;
    if (falloff !== null) onFalloff = onFalloff === null ? falloff : (onFalloff + falloff) / 2;
    if (luma >= cfg.brightLuma) {
      const brightSince = s.brightSince ?? now;
      if (now - brightSince >= cfg.brightDwellMs) {
        return {
          state: { ...s, ...offReset(), cooldownUntil: now + cfg.cooldownMs, lastBrightOffAt: now },
          turn: "off",
        };
      }
      return { state: { ...s, onBaseline, onFalloff, brightSince }, turn: null };
    }
    return { state: { ...s, onBaseline, onFalloff, brightSince: null }, turn: null };
  }
  if (onBaseline === null) onBaseline = luma;
  // PRIMARY: the torch's hotspot flattening out. Only trusted when the torch
  // made a real hotspot to begin with (see falloffBaselineMin) — otherwise the
  // geometry has nothing to say and the cap probe is the answer.
  const collapsed =
    falloff !== null &&
    onFalloff !== null &&
    onFalloff >= cfg.falloffBaselineMin &&
    falloff < onFalloff * cfg.falloffCollapse;
  const relThreshold = Math.max(cfg.brightOffFloor, onBaseline + cfg.brightMargin + s.marginBoost);
  if (collapsed || luma >= cfg.brightLuma || luma >= relThreshold) {
    const brightSince = s.brightSince ?? now;
    if (now - brightSince >= cfg.brightDwellMs) {
      return {
        state: { ...s, ...offReset(), cooldownUntil: now + cfg.cooldownMs, lastBrightOffAt: now },
        turn: "off",
      };
    }
    return { state: { ...s, onBaseline, onFalloff, brightSince }, turn: null };
  }
  return { state: { ...s, onBaseline, onFalloff, brightSince: null }, turn: null };
}

/** The parts of the state an OFF clears — session learning survives. */
function offReset(): Pick<
  TorchAutoState,
  "on" | "wantSince" | "brightSince" | "onAt" | "onBaseline" | "onFalloff" | "sawStructure"
> {
  return {
    on: false,
    wantSince: null,
    brightSince: null,
    onAt: null,
    onBaseline: null,
    onFalloff: null,
    sawStructure: false,
  };
}

/** External off — sheet opened, scan landed, scanner closing, user override.
 *  Cooldown applies so the next armed frame doesn't insta-flash. */
export function torchAutoRelease(
  s: TorchAutoState,
  now: number,
  cfg: TorchAutoConfig = TORCH_AUTO_DEFAULTS,
): TorchAutoState {
  // Session learning (marginBoost / lastBrightOffAt) survives a release.
  return { ...s, ...offReset(), cooldownUntil: Math.max(s.cooldownUntil, now + cfg.cooldownMs) };
}

// ── canvas glue (browser-only; exercised by the camera e2e) ───────

/** Mean luma AND centre/edge falloff of the live video, via a tiny downscale —
 *  cheap enough to run a couple of times a second inside the decode loop.
 *  The falloff is what survives auto-exposure (see the file header). */
export function sampleVideoLuma(
  video: HTMLVideoElement,
  scratch: HTMLCanvasElement,
  /** The previous call's pixels (from `raw` below) — enables sceneDelta. */
  prev?: Uint8ClampedArray | null,
): (LumaSample & { raw: Uint8ClampedArray }) | null {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const w = 32;
  const h = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * w));
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  // Centre box = middle third each way (where a torch hotspot lands); edge =
  // the outer ring. Their ratio is exposure-invariant.
  const cx0 = Math.floor(w / 3), cx1 = Math.ceil((w * 2) / 3);
  const cy0 = Math.floor(h / 3), cy1 = Math.ceil((h * 2) / 3);
  let sum = 0;
  let centreSum = 0, centreN = 0;
  let edgeSum = 0, edgeN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = (rgba[p]! * 77 + rgba[p + 1]! * 150 + rgba[p + 2]! * 29) >> 8;
      sum += v;
      if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
        centreSum += v;
        centreN += 1;
      } else if (x < w / 6 || x >= (w * 5) / 6 || y < h / 6 || y >= (h * 5) / 6) {
        edgeSum += v;
        edgeN += 1;
      }
    }
  }
  const centre = centreN ? centreSum / centreN : 0;
  const edge = edgeN ? edgeSum / edgeN : 0;
  // Grayscale copy for the scene-change metric: mean absolute difference vs
  // the caller's previous sample. The phone being raised is a huge spike; a
  // static dangle is near zero. Resolution-matched frames only.
  const raw = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < raw.length; i++, p += 4) {
    raw[i] = (rgba[p]! * 77 + rgba[p + 1]! * 150 + rgba[p + 2]! * 29) >> 8;
  }
  let sceneDelta: number | undefined;
  if (prev && prev.length === raw.length) {
    let diff = 0;
    for (let i = 0; i < raw.length; i++) diff += Math.abs(raw[i]! - prev[i]!);
    sceneDelta = diff / raw.length;
  }
  return { mean: sum / (w * h), falloff: centre / Math.max(1, edge), sceneDelta, raw };
}
