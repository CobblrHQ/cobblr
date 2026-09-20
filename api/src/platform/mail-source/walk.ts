// The walk of one mailbox, pure: it knows the MailSource interface, the
// allowlist query and two callbacks (seen, deliver), and nothing about
// Gmail, tokens or tables. The ids it fetches ARE the exposure, so a test
// runs it against a fake with in-memory callbacks and reads that list.

import { gmailQuery } from "./allowlist.js";
import type { MailMessage, MailSource } from "./types.js";

/** How far back the first read goes: a parcel already in flight is picked
 *  up; a month of history is not. */
export const BACKFILL_DAYS = 7;
/** The cursor steps back this far each round: the source's clock and ours
 *  disagree by seconds, and a message that landed during the last walk must
 *  not fall between two rounds. The archive makes the overlap free. */
export const OVERLAP_MS = 24 * 60 * 60_000;
/** Ids read per round per mailbox. A backfill of a busy mailbox finishes
 *  over a few rounds rather than holding one round for minutes. */
export const MAX_PER_ROUND = 200;
export interface SyncDeps {
  source: MailSource;
  senders: readonly string[];
  cursorAt: Date | null;
  now: Date;
  seen: (id: string) => Promise<boolean>;
  deliver: (msg: MailMessage) => Promise<void>;
  maxMessages?: number;
  backfillDays?: number;
  overlapMs?: number;
}

export interface SyncResult {
  listed: number;
  skipped: number;
  fetched: number;
  delivered: number;
  failed: number;
  /** Where the next round starts (minus the overlap). */
  cursorAt: Date;
  /** The walk stopped at the per-round cap; more is waiting. */
  more: boolean;
}

/** One walk of one mailbox. Grant errors propagate; a delivery error counts
 *  and the walk goes on. */
export async function syncMailbox(deps: SyncDeps): Promise<SyncResult> {
  const max = deps.maxMessages ?? MAX_PER_ROUND;
  const backfillMs = (deps.backfillDays ?? BACKFILL_DAYS) * 24 * 60 * 60_000;
  const since = deps.cursorAt ? deps.cursorAt.getTime() - (deps.overlapMs ?? OVERLAP_MS) : deps.now.getTime() - backfillMs;
  const result: SyncResult = { listed: 0, skipped: 0, fetched: 0, delivered: 0, failed: 0, cursorAt: deps.now, more: false };
  const q = gmailQuery(deps.senders, since / 1000);
  if (!q) return result;

  // The seen-check runs BEFORE the cap, so a capped round is a cap on NEW
  // messages: a round that took the newest two hundred and stopped would
  // otherwise list the same two hundred next time, skip them all, and never
  // reach the older ones behind them.
  let pageToken: string | undefined;
  const todo: string[] = [];
  do {
    const page = await deps.source.list(q, pageToken);
    result.listed += page.ids.length;
    for (const id of page.ids) {
      if (await deps.seen(id)) {
        result.skipped += 1;
        continue;
      }
      todo.push(id);
      if (todo.length >= max) break;
    }
    pageToken = page.nextPageToken;
    if (todo.length >= max) {
      result.more = true;
      break;
    }
  } while (pageToken);

  // Oldest first, so a backfill applies "Shipped" before "Delivered" and the
  // parcel's state never has to walk backwards. Gmail lists newest first.
  for (const id of todo.reverse()) {
    const msg = await deps.source.fetch(id);
    if (!msg) continue;
    result.fetched += 1;
    try {
      await deps.deliver(msg);
      result.delivered += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[mail-source] delivery failed for ${id}:`, (err as Error).message);
    }
  }
  return result;
}


/** A source failing this long earns its one card. */
export const FAILING_CARD_AFTER_MS = 24 * 60 * 60_000;

export interface StoppedState {
  status: "ok" | "needs_reconnect" | "failing";
  last_synced_at: Date | null;
  cursor_at: Date | null;
  stopped_notified_at: Date | null;
}

/** What a sync that did not finish leaves behind, and whether to tell the
 *  person: a dead grant tells at once; a transient failure tells after a
 *  day; either tells ONCE, until a round succeeds and resets the state,
 *  because a poll every five minutes must never be a card every five
 *  minutes. */
export function planStopped(state: StoppedState, grantDied: boolean, now: Date): { status: "needs_reconnect" | "failing"; tell: boolean } {
  const failingSince = state.last_synced_at ?? state.cursor_at ?? now;
  const failingFor = now.getTime() - failingSince.getTime();
  const alreadyTold = state.stopped_notified_at != null && state.status !== "ok";
  const tell = !alreadyTold && (grantDied || failingFor >= FAILING_CARD_AFTER_MS);
  return { status: grantDied ? "needs_reconnect" : "failing", tell };
}
