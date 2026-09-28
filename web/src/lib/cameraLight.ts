// The camera light never comes on unless the person asked (#3933).
//
// The booth fix (2026-09-24) narrowed WHEN the automatic light fires (only a
// code in view that will not read, in a dim scene) but not WHETHER: "Auto
// flash" started ON on every camera open and was never remembered, so turning
// it off lasted one visit and the light kept coming on by itself. A person
// reported it again (#3933).
//
// So there is one rule for turning the light on, and every "on" goes through
// it (lint: the capabilities row `camera:torch-on`):
//   - a press of the flashlight button always may;
//   - the automatic assist may only when the person switched "Auto light" on,
//     and that switch is OFF until they do, remembered on this device;
//   - the light comes back on by itself at the next camera open only if the
//     person left it on last time, the same choice remembered.
// Turning the light OFF is never gated.

import { setTorch } from "./barcodeScanner";

export type LightSource = "manual" | "auto" | "remembered";

export interface LightPrefs {
  /** The automatic assist is allowed. Off until the person turns it on. */
  autoLight: boolean;
  /** The person left the flashlight on: light it again when the camera opens. */
  torch: boolean;
}

const KEY = "cobblr-scan-light";
export const LIGHT_DEFAULTS: LightPrefs = { autoLight: false, torch: false };

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** This device's light choices; the defaults when nothing was chosen (or
 *  storage is unavailable): no automatic light, flashlight off. */
export function readLightPrefs(storage: Storage | null = store()): LightPrefs {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...LIGHT_DEFAULTS };
    const v = JSON.parse(raw) as Partial<LightPrefs>;
    return { autoLight: v.autoLight === true, torch: v.torch === true };
  } catch {
    return { ...LIGHT_DEFAULTS };
  }
}

export function writeLightPrefs(patch: Partial<LightPrefs>, storage: Storage | null = store()): LightPrefs {
  const next = { ...readLightPrefs(storage), ...patch };
  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a private window: the choice lasts this visit */
  }
  return next;
}

/** May this source turn the light to `on`? Off is always allowed. */
export function lightMay(source: LightSource, on: boolean, prefs: LightPrefs): boolean {
  if (!on) return true;
  if (source === "manual") return true;
  if (source === "auto") return prefs.autoLight;
  return prefs.torch;
}

/** Set the light, if the rule allows it. False when refused or unsupported. */
export async function applyLight(
  track: MediaStreamTrack | null,
  source: LightSource,
  on: boolean,
  prefs: LightPrefs = readLightPrefs(),
): Promise<boolean> {
  if (!lightMay(source, on, prefs)) return false;
  return setTorch(track, on);
}
