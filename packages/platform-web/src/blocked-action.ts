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
// will do first. A switch the person holds themselves (an app that is off,
// for its owner) is different: the call that was refused waits for the sheet
// and runs again itself, so whatever it answers next (done, or a second
// refusal with its own remedy) reaches the page that asked, the way the first
// answer would have (#5890).

import { approvalDedupeKey, type BlockedAction } from "@cobblr/platform-contract/blocked-action";

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
  /** Set when the refused call is waiting to carry on by itself: the sheet
   *  settles it instead of replaying the request. */
  settle?: (outcome: SheetOutcome) => void;
}

/** What became of a sheet the refused call waited on. */
export type SheetOutcome = "applied" | "dismissed";

type Listener = (raised: RaisedBlock | null) => void;
const listeners = new Set<Listener>();
let current: RaisedBlock | null = null;
let waiting: Array<(outcome: SheetOutcome) => void> = [];

export function raiseBlockedAction(raised: RaisedBlock): void {
  // The same ask again while it is open is one ask: a bulk Add-all that
  // meets the same missing app on every row raises the sheet once, not once
  // per row (#3610). Each call waiting on it carries on when it settles.
  if (current && approvalDedupeKey(current.blocked.remedies) === approvalDedupeKey(raised.blocked.remedies) && raised.blocked.remedies.length > 0) {
    if (raised.settle) waiting.push(raised.settle);
    return;
  }
  settleBlockedAction("dismissed");
  current = raised;
  if (raised.settle) waiting.push(raised.settle);
  listeners.forEach((l) => l(current));
}

/** Tell every call waiting on the open sheet what became of it. */
export function settleBlockedAction(outcome: SheetOutcome): void {
  const now = waiting;
  waiting = [];
  now.forEach((settle) => settle(outcome));
}

export function clearBlockedAction(): void {
  settleBlockedAction("dismissed");
  current = null;
  listeners.forEach((l) => l(null));
}

/** Raise the sheet and wait for the person: "applied" once the switch is on,
 *  "dismissed" if they close it. */
export function awaitBlockedAction(raised: Omit<RaisedBlock, "settle">): Promise<SheetOutcome> {
  return new Promise((resolve) => raiseBlockedAction({ ...raised, settle: resolve }));
}

/** The refused request a call may carry on with itself, or null: only a
 *  switch the person holds (selfApply), only for a request worth replaying.
 *  An ask waits on someone else, so the sheet keeps that request instead. */
export function carriesOnItself(blocked: BlockedAction | undefined, method: string, path: string, body: unknown): RefusedRequest | null {
  return blocked?.selfApply ? refusedRequestFor(method, path, body) : null;
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
