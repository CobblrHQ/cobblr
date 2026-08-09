// "There is something LIVE behind this modal that the user still needs to see."
//
// The mobile rule is that a modal takes the whole screen (2026-08-01). That is
// right for a modal over a page, and wrong for one over the camera: the scan
// result card is positioned over a running viewfinder ON PURPOSE, so you can
// keep the item in frame while you read the match. Going full-bleed turned it
// into a blocking page and hid the thing you were pointing at (feedback: "that one
// actually needed to be the way that it was").
//
// This is a CONTEXT rather than a per-modal prop deliberately. Every modal the
// camera opens (the result card, the bin adjuster, the ambiguity picker, and
// whatever gets added next) sits over the same live viewfinder, so the camera
// declares the condition ONCE and no author has to remember an opt-out they
// have never heard of. Wrapping is the only thing anyone has to get right, and
// forgetting it is visible the moment you open the camera.

import { createContext, useContext, type ReactNode } from "react";

const LiveSurfaceCtx = createContext(false);

/** Wrap a surface that stays live behind its modals (the camera viewfinder). */
export function LiveSurfaceProvider({ children }: { children: ReactNode }) {
  return <LiveSurfaceCtx.Provider value={true}>{children}</LiveSurfaceCtx.Provider>;
}

/** True when this modal is rendered over a live surface, so it must stay a
 *  card on mobile instead of claiming the viewport. */
export function useOverLiveSurface(): boolean {
  return useContext(LiveSurfaceCtx);
}
