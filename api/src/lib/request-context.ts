// Per-request AsyncLocalStorage. Lets deep helpers (especially
// activity.log()) auto-pull who-acted + how-authenticated from the
// current Express request without threading req through every
// signature.
//
// Set in a single middleware right after requireAuth; cleared
// automatically at the end of the async chain by ALS scoping.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthMethod } from "../db/schema.js";
import type { ActivityViaKind } from "@cobblr/platform-contract";

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
  /** Where a link this request makes starts (link-origin.ts), for a deep
   *  helper with no request to hand: an invite Cobb makes through an action. */
  linkOrigin?: string;
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
export type ViaKind = ActivityViaKind;
export interface Via {
  kind: ViaKind;
  /** The automation's name for kind 'automation'; the label's title for
   *  kind 'label' (a scanned action label, #3897); the surface's name for
   *  kind 'surface' ("floor plan"). */
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

// ONE REQUEST, ITS OWN META QUERIES (#4876). A lookup made per record on a
// list or batch path took the whole meta pool: resolveKind's registry read and
// getFieldReadScopes' per-workspace overrides ran once per row, 333 callers
// queued on 80 clients in CI. Two things live here so that class stays fixed:
//   memo     a per-request cache: the same question asked for every row of
//            one response is asked of the database once (perRequest below),
//            and the next request asks again, so an admin's edit still takes
//            effect at once;
//   meta     the meta statements this request ran, counted, so a test can
//            assert a bound ("listing 300 records uses a bounded number of
//            meta checkouts") and a regression fails there by name.
export interface RequestScope {
  memo: Map<string, Promise<unknown>>;
  meta: Map<string, number>;
  /** Set by a handler that only READS (the activity feed): reads wrapped in
   *  perReadRequest are then asked once per request instead of once per row. */
  readOnly?: boolean;
  /** "GET /orgs/:slug/records (a-test-file.test.ts)": which request, and in CI
   *  which test file sent it, so a pool's holders and waiters name the burst
   *  that starved it, not only the query each one ran. */
  label?: string;
}
const scopeStorage = new AsyncLocalStorage<RequestScope>();

/** A request as a pool's holders name it: the route with its ids and the
 *  workspace slug collapsed (so forty calls of one route count as one), and
 *  the test file that sent it when one says so (the api tests' setup does). */
export function requestLabel(method: string, path: string, testFile?: string | null): string {
  const route = path
    .replace(/^\/orgs\/[^/]+/, "/orgs/:slug")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .slice(0, 120);
  const file = testFile && /^[\w.-]{1,120}$/.test(testFile) ? ` (${testFile})` : "";
  return `${method} ${route}${file}`;
}

/** Run fn as one request: its own memo and its own meta statement count. */
export function runRequestScope<T>(fn: () => T, scope: RequestScope = { memo: new Map(), meta: new Map() }): T {
  return scopeStorage.run(scope, fn);
}

/** Detached housekeeping must not retain a response's memo or change its
 * measured cost depending on when it finishes. Actor and via stay intact. */
export function runOutsideRequestScope<T>(fn: () => T): T {
  return scopeStorage.exit(fn);
}

/** The current request's scope, or null outside one (a timer, a boot pass). */
export function currentRequestScope(): RequestScope | null {
  return scopeStorage.getStore() ?? null;
}

/** `load()` once per request for `key`; outside a request, every time. A
 *  failure is not kept: the next asker tries again. */
export function perRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const scope = scopeStorage.getStore();
  if (!scope) return load();
  const hit = scope.memo.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = load();
  scope.memo.set(key, p);
  p.catch(() => scope.memo.delete(key));
  return p;
}

/** Forget what this request remembered under the keys `match` picks: a write
 *  that changes what a memo answers (a field defined, a collection made)
 *  calls it, so the same request never reads its own change as it was. A
 *  no-op outside a request. */
export function forgetPerRequest(match: (key: string) => boolean): void {
  const scope = scopeStorage.getStore();
  if (!scope) return;
  for (const key of [...scope.memo.keys()]) if (match(key)) scope.memo.delete(key);
}

/** Say this request only reads: from here, perReadRequest answers a repeated
 *  question from memory. A no-op outside a request. Never call it from a handler
 *  that writes the rows perReadRequest covers (instances, overrides), or the
 *  rest of that request would read what it had just changed as it was. */
export function markRequestReadOnly(): void {
  const scope = scopeStorage.getStore();
  if (scope) scope.readOnly = true;
}

/** `perRequest`, but only in a request that said it only reads. Otherwise the
 *  question is asked every time, as before: a kernel read that many places make,
 *  and some of them after writing what it reads (a provision, an override), must
 *  not start answering from memory for writers. The activity feed asked for an
 *  instance and an override once per row (180 statements for 100 rows, main red
 *  on run 37212): in a read-only request it asks once. */
export function perReadRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  return scopeStorage.getStore()?.readOnly ? perRequest(key, load) : load();
}

/** Note one meta statement for the current request (client-error-guard). */
export function noteMetaStatement(text: string): void {
  const scope = scopeStorage.getStore();
  if (!scope) return;
  const key = text.replace(/\s+/g, " ").trim().slice(0, 160);
  scope.meta.set(key, (scope.meta.get(key) ?? 0) + 1);
}
