// The drift-detection rule (`computeAwaySince`). Given a mobile item's
// before/after state, decide
// the `away_since` stamp:
//
//   - not mobile                       → null (fixtures are never "away")
//   - no home, or no current location  → null (nothing to be away from)
//   - current == home                  → null (it's home)
//   - just drifted (was null)          → now  (stamp the transition)
//   - still away (was already stamped) → keep (preserve the age — the WHOLE
//                                              point; an unrelated edit must
//                                              not reset the chip)
//
// Pure + side-effect free so it's trivially testable and identical on every
// call site. Returns a Date to stamp, `null` to clear, or the sentinel "keep"
// meaning "leave the existing away_since untouched".

export interface MobilityState {
  mobility: string | null | undefined;
  /** current location id */
  location: string | null | undefined;
  /** home location id */
  home: string | null | undefined;
}

/** @param before prior stamp + (unused) state; only `awaySince` is read here.
 *  @param effective the post-write mobility/location/home to evaluate against.
 *  @param now injected so the caller controls the clock (and tests are stable). */
export function computeAwaySince(
  before: { awaySince: Date | string | null },
  effective: MobilityState,
  now: Date,
): Date | null | "keep" {
  if (effective.mobility !== "mobile") return null;
  if (!effective.home || !effective.location) return null;
  if (effective.location === effective.home) return null;
  return before.awaySince == null ? now : "keep";
}
