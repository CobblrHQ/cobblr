// Is this the thing in the user's hand? The one rule the app already has for
// that question (photoDevice.ts: a coarse pointer AND a narrow viewport), as
// a hook. Sampled once on mount, like useIsTouch: a value that flips under the
// user would swap a surface out from under them mid-read.
import { useState } from "react";
import { canPhotographHere, measureDevice } from "./photoDevice";

/** True on a phone held in the hand; false on a desktop, a laptop and a
 *  shrunk desktop window. */
export function useHandheld(): boolean {
  const [handheld] = useState(() => canPhotographHere(measureDevice()));
  return handheld;
}
