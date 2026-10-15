// One request for a read asked twice at once (#6613).
//
// A cold load asked the server for the same thing two or three times: the
// shell's strip, its deletion notice and its update badge each asked for the
// workspace's trial state as they mounted, before any answer had landed. A
// GET already on its way, for the same path as the same person, is the answer
// a second asker gets: each asker reads its own copy of the one response.
//
// Only while it is in flight: an answer that has landed is the caller's cache
// to keep (its query), not this. A write drops what is in flight, so a read
// asked after a write is never answered by one sent before it.

import { changesNothing } from "./workspace-writes";

const inFlight = new Map<string, Promise<Response>>();

/** `send`'s response, shared with every same `key` GET asked before it lands.
 *  `key` names the read and who asks it (path, credentials). */
export function sharedRead(method: string, key: string, send: () => Promise<Response>): Promise<Response> {
  if (method.toUpperCase() !== "GET") {
    if (!changesNothing(key)) inFlight.clear();
    return send();
  }
  let going = inFlight.get(key);
  if (!going) {
    const sent = send();
    going = sent;
    inFlight.set(key, sent);
    const done = () => {
      if (inFlight.get(key) === sent) inFlight.delete(key);
    };
    sent.then(done, done);
  }
  // Every asker gets a copy; the one response is never read itself, so a
  // copy can still be taken for whoever asks next.
  return going.then((r) => r.clone());
}

/** For a test: the state between tests. */
export function resetSharedReads(): void {
  inFlight.clear();
}
