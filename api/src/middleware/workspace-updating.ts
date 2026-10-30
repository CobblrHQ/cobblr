import type { Response } from "express";

/** How long a request waits for its workspace's migration before it is
 *  answered "updating" instead. A request never pays for a migration: on a
 *  slow box one took 77 to 103 s, and the person who opened the workspace
 *  first after a roll waited all of it. */
export const REQUEST_MIGRATION_WAIT_MS = 3_000;
export const UPDATING_RETRY_AFTER_S = 3;
/** Set on the answer, so the app can tell it from any other 503 without reading the body. */
export const UPDATING_HEADER = "x-cobblr-workspace-updating";

/** True when the workspace is ready to serve; otherwise the request is
 *  answered 503 `workspace_updating`, with Retry-After, and false. `wait` is
 *  the workspace's migration (it is already running, ahead of the catch-up's
 *  queue), or null when it has none. */
export async function readyOrAnsweredUpdating(wait: Promise<void> | null, res: Response, ms = REQUEST_MIGRATION_WAIT_MS): Promise<boolean> {
  if (!wait) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    wait.then(() => true, () => true),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
  ]);
  clearTimeout(timer);
  if (ready) return true;
  res.setHeader("Retry-After", String(UPDATING_RETRY_AFTER_S));
  res.setHeader(UPDATING_HEADER, "1");
  res.status(503).json({ error: { code: "workspace_updating", message: "This workspace is being updated to the new version. Try again in a few seconds." } });
  return false;
}
