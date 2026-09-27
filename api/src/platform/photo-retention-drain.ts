// Sending queued photo-retention requests (photo-retention.ts), apart from the
// database so it can be held by a test without one.
import type { PhotoRetentionKind } from "@cobblr/platform-contract/photo-retention";

/** Backoff between tries: 1, 2, 4 … minutes, never more than six hours. */
export const retryDelayMs = (attempts: number): number => Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
/** Past this many tries a request is logged as stuck on every round. */
const STUCK_AFTER = 8;

export interface PendingRequest {
  actor: string;
  kind: PhotoRetentionKind;
  attempts: number;
}
export interface PendingStore {
  due(now: Date): Promise<PendingRequest[]>;
  done(actor: string): Promise<void>;
  failed(actor: string, attempts: number, error: string, nextAt: Date): Promise<void>;
}

/** Send every due request once. Pure over the store and the sender. */
export async function drainPhotoRetention(
  store: PendingStore,
  send: (kind: PhotoRetentionKind, actor: string) => Promise<number>,
  now: Date = new Date(),
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const req of await store.due(now)) {
    try {
      await send(req.kind, req.actor);
      await store.done(req.actor);
      sent++;
    } catch (err) {
      const attempts = req.attempts + 1;
      const message = (err as Error).message;
      await store.failed(req.actor, attempts, message, new Date(now.getTime() + retryDelayMs(attempts)));
      failed++;
      if (attempts >= STUCK_AFTER) console.error(`[photo-retention] a ${req.kind} request has failed ${attempts} times: ${message}`);
    }
  }
  return { sent, failed };
}
