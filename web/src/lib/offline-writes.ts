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

/** Send what an earlier page left waiting, as the signed-in person. */
export function sendWaitingWritesNow(): ReturnType<typeof sendWaitingWrites> {
  const token = getToken();
  return sendWaitingWrites(token ? `Bearer ${token}` : null, async (w: WaitingWrite) => {
    try {
      await request(w.method, w.path, w.body, { [SENDING_A_WAITING_WRITE]: "1", ...(w.key ? { [IDEMPOTENCY_KEY]: w.key } : {}), ...(w.editedFrom ? { [EDITED_FROM_HEADER]: encodeEditedFrom(w.editedFrom) } : {}) });
      return { outcome: "landed" };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) return { outcome: "unreachable" };
      // The same create, by its key, is still running on the server (a send cut
      // short and sent again): it waits for the next try, never dropped (#7923).
      if (e instanceof ApiError && e.status === 409 && e.code === "request_in_progress") return { outcome: "unreachable" };
      return { outcome: "refused", reason: e instanceof Error ? e.message : String(e) };
    }
  });
}
