// Says on <html data-settled> whether the app has stopped fetching: "true"
// when no query and no mutation is in flight, "false" while one is.
//
// The seam a browser check waits on (scripts/walk.mjs, the fundamentals
// nightly). They used to wait for the network to go quiet, which on a page
// that polls never happens: every page waited out a 20 s cap, and three of
// ten nightly areas went unwalked for lack of time (2026-10-03). Between two
// polls nothing is in flight, so this settles as soon as the page has what it
// asked for. Renders nothing.
//
// It also counts every request the app makes outside a query (the sign-in
// check, a one-off read), through lib/in-flight.ts: the app loads in waves
// (signed in, then the workspace, then the page), and between two waves no
// query was in flight, so a walk judged a page with nothing on it yet.
import { useEffect, useSyncExternalStore } from "react";
import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { inFlight, onInFlight } from "../lib/in-flight";

export function SettledMarker() {
  const requests = useSyncExternalStore(onInFlight, inFlight, () => 0);
  const busy = useIsFetching() + useIsMutating() + requests;
  useEffect(() => {
    document.documentElement.dataset.settled = busy === 0 ? "true" : "false";
  }, [busy]);
  return null;
}
