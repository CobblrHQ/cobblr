// Which remembered Bluetooth device belongs to THIS printer row.
//
// Two printers of the same model advertise the same name, so matching a
// remembered device by its model profile picks whichever came back first. With
// two PM220S loaded with different stock that silently prints a job on the wrong
// machine — and per-printer media memory makes it worse, because each row then
// confidently believes it knows what is loaded.
//
// Web Bluetooth's device.id is the only handle that separates two identical
// units. It is origin-scoped and randomised (deliberately NOT a MAC), so it is
// stable for a browser profile and meaningless anywhere else. That is why an
// unmatched bound id falls to the chooser instead of guessing: on a new computer
// the user re-picks once and the row re-binds.
//
// Pure so the rules are testable without a Bluetooth stack.

export interface KnownDevice {
  readonly id: string;
  readonly name?: string;
}

export type BindingReason =
  /** The row's remembered device.id matched exactly — the only certain case. */
  | "bound"
  /** No id remembered yet, and exactly one device is known: adopt it. */
  | "sole"
  /** No id remembered; several known, one matched this row's model. */
  | "profile"
  /** Several known devices share this model and none is bound — must ask. */
  | "ambiguous"
  /** Nothing usable; show the chooser. */
  | "none";

export interface BindingResult<D extends KnownDevice> {
  device: D | null;
  reason: BindingReason;
}

/** Pick the remembered device for a printer row, or say why it cannot.
 *
 *  `matchesProfile` reports whether a device's advertised name maps to the row's
 *  model, so this stays free of the profile registry. */
export function pickBoundDevice<D extends KnownDevice>(
  known: readonly D[],
  settings: { deviceId?: string; profileId?: string },
  matchesProfile: (device: D, profileId: string) => boolean,
): BindingResult<D> {
  if (settings.deviceId) {
    const bound = known.find((d) => d.id === settings.deviceId);
    // A bound row NEVER falls back to another device. The remembered printer is
    // simply not here (off, out of range, or a different browser), and quietly
    // substituting a same-model neighbour is the exact cross-print this exists to
    // prevent. The chooser is the correct answer.
    return bound ? { device: bound, reason: "bound" } : { device: null, reason: "none" };
  }

  if (known.length === 0) return { device: null, reason: "none" };

  // Unbound row. One known device is unambiguous, so adopt it and let the caller
  // persist the binding.
  if (known.length === 1) return { device: known[0]!, reason: "sole" };

  if (settings.profileId) {
    const sameModel = known.filter((d) => matchesProfile(d, settings.profileId!));
    if (sameModel.length === 1) return { device: sameModel[0]!, reason: "profile" };
    // TWO devices of the same model and nothing bound: the case that printed on
    // the wrong machine. Refuse to guess.
    if (sameModel.length > 1) return { device: null, reason: "ambiguous" };
  }

  return { device: null, reason: "none" };
}
