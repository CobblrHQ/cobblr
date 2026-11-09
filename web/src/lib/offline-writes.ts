// How a write made offline waits (#7863). The page's mutation runs once, so
// its door can keep the write on this device (waiting-writes.ts in
// platform-web); then it waits for the connection and runs again. With React
// Query's default it waited before ever reaching the door, in memory only,
// and a reload lost it.
import { MutationCache, onlineManager, type Mutation, type MutationOptions, type MutationState, type QueryClient } from "@tanstack/react-query";
import { IDEMPOTENCY_KEY, asAPersonsWrite, browserOffline, sendWaitingWrites, type WaitingWrite } from "@cobblr/platform-web";
import { ApiError, getToken } from "./api";
import { request } from "./api/client";
import { EDITED_FROM_HEADER, encodeEditedFrom } from "@cobblr/platform-contract/edited-from";

export const WAITING_MUTATIONS = {
  networkMode: "offlineFirst",
  // A page opened offline starts out believing it is online (the browser only
  // says "offline" when it changes), so the failed write tells it: the write
  // then waits for "online" instead of being tried again every few seconds.
  // Reads are left to run until then, so a reloaded page still shows what it kept.
  retry: () => {
    if (!browserOffline()) return false;
    onlineManager.setOnline(false);
    return true;
  },
  // It is only ever tried again once the connection is back, so with no pause first.
  retryDelay: 0,
} satisfies Pick<MutationOptions, "networkMode" | "retry" | "retryDelay">;

/** The app's mutation cache: every mutation's function runs as a person's
 *  write, so the door it reaches may keep it offline. A write the page makes
 *  on its own, outside a mutation, is never kept. */
export class PersonsWritesCache extends MutationCache {
  build<TData, TError, TVariables, TContext>(
    client: QueryClient,
    options: MutationOptions<TData, TError, TVariables, TContext>,
    state?: MutationState<TData, TError, TVariables, TContext>,
  ): Mutation<TData, TError, TVariables, TContext> {
    const fn = options.mutationFn;
    const asked = fn ? { ...options, mutationFn: (...args: Parameters<typeof fn>) => asAPersonsWrite(() => fn(...args)) } : options;
    return super.build(client, asked, state);
  }
}

/** Marks a waiting write being sent, so a send cut short is not kept twice. */
export const SENDING_A_WAITING_WRITE = "x-cobblr-waited";

/** The answers that refuse the change itself: its body, the record it names,
 *  the rule or the newer change it meets. Only these drop a waiting change. */
const REFUSES_THE_CHANGE = new Set([400, 403, 404, 405, 409, 410, 412, 413, 415, 422]);
/** Refusals of this session, not of the change: a read-only support session,
 *  a share's View as, a guest; the same create still running (#7923). */
const ABOUT_THE_SESSION = new Set(["impersonation_read_only", "share_view_read_only", "guest_not_shared", "request_in_progress"]);

/** Whether an answer refuses the change itself, so it is dropped and said.
 *  Anything else (busy, signed out, timed out, a server failing, an error that
 *  is no answer at all) leaves it waiting for the next try (#9366): dropped on
 *  a 429, a change the person was told would wait was thrown away. */
export function refusesTheChange(e: unknown): e is ApiError {
  return e instanceof ApiError && REFUSES_THE_CHANGE.has(e.status) && !ABOUT_THE_SESSION.has(e.code) && !(e.status === 409 && e.retryAfterSec !== null);
}

/** Send what an earlier page left waiting, as the signed-in person. */
export function sendWaitingWritesNow(): ReturnType<typeof sendWaitingWrites> {
  const token = getToken();
  return sendWaitingWrites(token ? `Bearer ${token}` : null, async (w: WaitingWrite) => {
    try {
      await request(w.method, w.path, w.body, { [SENDING_A_WAITING_WRITE]: "1", ...(w.key ? { [IDEMPOTENCY_KEY]: w.key } : {}), ...(w.editedFrom ? { [EDITED_FROM_HEADER]: encodeEditedFrom(w.editedFrom) } : {}) });
      return { outcome: "landed" };
    } catch (e) {
      if (refusesTheChange(e)) return { outcome: "refused", reason: e.message };
      return { outcome: "unreachable", retryAfterSec: e instanceof ApiError ? e.retryAfterSec : null };
    }
  });
}
