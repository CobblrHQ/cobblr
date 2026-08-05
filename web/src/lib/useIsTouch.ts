// Is this a touch-primary device?
//
// Third copy of `matchMedia("(pointer: coarse)")` was about to be written, after
// PairPhoneButton and WhatToDoPanel, so it lives here instead. It is registered
// in scripts/capabilities.ts, which fails CI on a fourth inline copy.
//
// Decided ONCE on mount and never re-read: this answers "what kind of machine is
// this", which does not change mid-session, and a value that flips under the
// user would re-render copy and swap affordances while they are reading them.
// (A window RESIZE is not a change of input device - that is what the responsive
// classes are for.)

import { useState } from "react";

/** True on phones/tablets - anything whose primary pointer is a finger. */
export function isTouchPrimary(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** `isTouchPrimary()` as a hook, sampled once on mount. */
export function useIsTouch(): boolean {
  const [touch] = useState(isTouchPrimary);
  return touch;
}
