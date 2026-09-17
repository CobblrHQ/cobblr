// The one door a refusal walks through.
//
// Every surface in the app reports an ApiError with `toast.error(e.message)`,
// and there are a hundred of those calls. Teaching each one what a refusal
// means would be the per-call-site fix the class complaint is about (#3073).
// So the api client raises a refusal HERE — the explanation the server sent,
// plus the request it refused — and one sheet mounted in the shell reads it.
// A surface that wants to offer the ask before the person is refused (a scan
// row that already knows it cannot file) raises the same shape itself.
//
// The refused request is kept so the yes can finish it: after approval the
// sheet replays it under the person's own session, once, and shows what it
// will do first.

import type { BlockedAction } from "@cobblr/platform-contract/blocked-action";

export interface RefusedRequest {
  method: "POST" | "PATCH" | "DELETE";
  /** The api path as the client sent it ("/orgs/<slug>/…"). */
  path: string;
  body: unknown;
}

export interface RaisedBlock {
  blocked: BlockedAction;
  /** What was refused, when a request was. A surface raising the sheet ahead
   *  of a refusal passes the request it would have made. */
  refused: RefusedRequest | null;
  /** Words for the request card: "File Smoked paprika into Spices". Falls back
   *  to the sentence's subject when a surface has none. */
  subject: string | null;
}

type Listener = (raised: RaisedBlock | null) => void;
const listeners = new Set<Listener>();
let current: RaisedBlock | null = null;

export function raiseBlockedAction(raised: RaisedBlock): void {
  current = raised;
  listeners.forEach((l) => l(current));
}

export function clearBlockedAction(): void {
  current = null;
  listeners.forEach((l) => l(null));
}

export function subscribeBlockedAction(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** A mutating method, for the request the client keeps. GET is never a
 *  refusal a request could remedy in the way the sheet offers. */
export function isMutating(method: string): method is RefusedRequest["method"] {
  return method === "POST" || method === "PATCH" || method === "DELETE";
}

/** The request to keep for the finish, or null when the thing refused is
 *  its own draft. A scan inbox row lives on the server and can change while
 *  an ask is pending (a later enrichment adds a doubt, the person renames
 *  it); replaying a snapshot of its File would file what it WAS. The yes
 *  reopens the inbox instead, and the row's current state decides what its
 *  button says. */
export function refusedRequestFor(method: string, path: string, body: unknown): RefusedRequest | null {
  if (!isMutating(method)) return null;
  if (/\/modules\/core-scan\/inbox\/[^/]+\/(confirm|attach)$/.test(path)) return null;
  return { method, path, body: body === undefined ? null : body };
}
