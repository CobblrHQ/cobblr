// Per-request AsyncLocalStorage. Lets deep helpers (especially
// activity.log()) auto-pull who-acted + how-authenticated from the
// current Express request without threading req through every
// signature.
//
// Set in a single middleware right after requireAuth; cleared
// automatically at the end of the async chain by ALS scoping.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthMethod } from "../db/schema.js";

export interface RequestActor {
  userId: string;
  authMethod: AuthMethod;
  /** Set when authMethod === "api_token". */
  apiTokenId: string | null;
}

const storage = new AsyncLocalStorage<RequestActor>();

/** Run the given function within an actor context. Used by
 *  requireAuth to wrap the rest of the request chain so anything
 *  downstream can call currentActor() without threading req through. */
export function runWithActor<T>(actor: RequestActor, fn: () => T): T {
  return storage.run(actor, fn);
}

/** Returns the actor for the current request, or null if outside one
 *  (e.g. a wire firing on a timer, a boot-time backfill). */
export function currentActor(): RequestActor | null {
  return storage.getStore() ?? null;
}
