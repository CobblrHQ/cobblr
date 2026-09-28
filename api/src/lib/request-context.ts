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
  /** How a titled work's title reads for this person (their `title_pref`),
   *  so a served entity's title is composed once, in the kernel, for whoever
   *  is asking (served-title.ts, #3061). Absent for a token or an actor
   *  with no preference: the default format. */
  titlePref?: string | null;
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

// HOW a write is being made, beside who (#3833). A separate store from the
// actor because an automation runs with the originating actor when there is
// one and with none when a background event fired it, and in both cases the
// activity row must say an automation did it. activity.log() reads this.
export type ViaKind = "mcp" | "assistant" | "automation";
export interface Via {
  kind: ViaKind;
  /** The automation's label, for kind 'automation'. */
  label?: string | null;
}
const viaStorage = new AsyncLocalStorage<Via>();

/** Run fn with every activity row written inside it marked `via`. */
export function runVia<T>(via: Via, fn: () => T): T {
  return viaStorage.run(via, fn);
}

/** The via of the current async chain, or null for a plain hand edit. */
export function currentVia(): Via | null {
  return viaStorage.getStore() ?? null;
}
