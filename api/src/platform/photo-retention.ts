// Retention requests for kept item photos: queued here, sent by one sweeper.
//
// The owner's rules (CobblrHQ/core#3769): the shared network keeps a confirmed
// item photo indefinitely and its link to the person for up to two years.
// Deleting the account ends the link at once (`unlink`); a person who asks
// for their photos to be deleted gets every still-linked photo deleted
// (`forget`, the data-request path the terms name, run by an operator with
// scripts/forget-photos.sh). Deleting an item sends nothing.
//
// Written to photo_retention_pending first and sent afterwards, so an
// unreachable network delays the request rather than losing it: once the
// account row is gone nothing could recompute the actor id. Only an account
// that accepted the photo terms can have sent a photo, so only such an
// account queues anything; until the terms ship, this does no work at all.
import { sql } from "kysely";
import {
  opaqueUserActor,
  photoRetentionTarget,
  sendPhotoRetention,
  type PhotoRetentionKind,
  type PhotoRetentionTarget,
} from "@cobblr/platform-contract/photo-retention";
import { meta } from "../db/meta.js";
import { runExclusive } from "./exclusive.js";
import { drainPhotoRetention, type PendingRequest, type PendingStore } from "./photo-retention-drain.js";

const TICK_MS = 10 * 60 * 1000;
/** Queue a request for a person. `forget` outranks `unlink`: a person who
 *  asked for deletion and then deleted their account still gets deletion.
 *  Returns false when the account can have sent no photo. */
export async function queuePhotoRetention(kind: PhotoRetentionKind, userId: string): Promise<boolean> {
  const row = await sql<{ accepted: Date | null }>`
    select photo_terms_accepted_at as accepted from users where id = ${userId}
  `.execute(meta);
  if (!row.rows[0]?.accepted) return false;
  const actor = opaqueUserActor(userId, process.env.JWT_SECRET);
  if (!actor) return false;
  await sql`
    insert into photo_retention_pending (actor, kind) values (${actor}, ${kind})
    on conflict (actor) do update
      set kind = case when photo_retention_pending.kind = 'forget' then 'forget' else excluded.kind end,
          next_at = now()
  `.execute(meta);
  return true;
}

export const metaPendingStore: PendingStore = {
  async due(now) {
    const r = await sql<PendingRequest>`
      select actor, kind, attempts from photo_retention_pending where next_at <= ${now} order by next_at limit 200
    `.execute(meta);
    return r.rows;
  },
  async done(actor) {
    await sql`delete from photo_retention_pending where actor = ${actor}`.execute(meta);
  },
  async failed(actor, attempts, error, nextAt) {
    await sql`
      update photo_retention_pending set attempts = ${attempts}, last_error = ${error.slice(0, 300)}, next_at = ${nextAt}
       where actor = ${actor}
    `.execute(meta);
  },
};

/** One round against the configured network. No network configured: the
 *  requests wait, since the install may be between two settings. */
export async function photoRetentionRound(target: PhotoRetentionTarget | null = photoRetentionTarget()): Promise<{ sent: number; failed: number }> {
  if (!target) return { sent: 0, failed: 0 };
  return drainPhotoRetention(metaPendingStore, (kind, actor) => sendPhotoRetention(kind, actor, target));
}

let handle: ReturnType<typeof setInterval> | null = null;
let running = false;
async function safeTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // SKIP-IF-BUSY OK: a timer tick; the holder sweeps, the next tick sweeps what is left
    await runExclusive("platform.photo-retention", async () => {
      const r = await photoRetentionRound();
      if (r.sent || r.failed) console.log(`[photo-retention] sent ${r.sent}, ${r.failed} still waiting`);
    });
  } catch (err) {
    console.warn("[photo-retention] round failed:", (err as Error).message);
  } finally {
    running = false;
  }
}

export function startPhotoRetentionSweeper(): void {
  if (handle) clearInterval(handle);
  handle = setInterval(safeTick, TICK_MS);
  handle.unref?.();
  setTimeout(safeTick, 60_000).unref?.();
}
