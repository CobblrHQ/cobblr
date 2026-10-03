// Says on <html data-settled> whether the app has stopped fetching: "true"
// when no query and no mutation is in flight, "false" while one is.
//
// The seam a browser check waits on (scripts/walk.mjs, the fundamentals
// nightly). They used to wait for the network to go quiet, which on a page
// that polls never happens: every page waited out a 20 s cap, and three of
// ten nightly areas went unwalked for lack of time (2026-10-03). Between two
// polls nothing is in flight, so this settles as soon as the page has what it
// asked for. Renders nothing.
import { useEffect } from "react";
import { useIsFetching, useIsMutating } from "@tanstack/react-query";

export function SettledMarker() {
  const busy = useIsFetching() + useIsMutating();
  useEffect(() => {
    document.documentElement.dataset.settled = busy === 0 ? "true" : "false";
  }, [busy]);
  return null;
}
