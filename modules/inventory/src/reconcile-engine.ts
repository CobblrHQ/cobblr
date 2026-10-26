// The one engine behind taking stock (#6302): "What's still here?" for one
// place and a recount of a whole collection both end by marking what was not
// found gone, setting what was counted, and keeping one Undo. This is that
// end, written once: the sheet and the recount are two screens over it, never
// two implementations of what "gone" or "counted" does to a record.
//
// Gone goes through the disposition door ("gone, not recorded how"), which
// never feeds shelf-life learning; a count is a correction on the lots. Both
// are all-or-nothing per call, and every write has its exact reverse here.
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { actionActed } from "@cobblr/platform-contract/action-result";
import { consumeOldest } from "./batches.js";
import { withBatches } from "./api/action-handlers.js";

export interface GoneRef {
  id: string;
  kind: string;
  title: string;
}

export interface CountChange {
  id: string;
  title: string;
  before: number;
  after: number;
}

/** Where a count came from, for the lots' ledger: the stocktake or recount row. */
export interface CountSource {
  kind: "stocktake" | "recount";
  id: string | null;
}

function byKind<T extends { id: string; kind: string }>(items: readonly T[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const i of items) out.set(i.kind, [...(out.get(i.kind) ?? []), i.id]);
  return out;
}

/** Mark every record gone, or none: a kind the door refuses puts back the
 *  kinds already marked, then says why. */
export async function markAllGone(orgId: string, userId: string | null, items: readonly GoneRef[], note: string): Promise<void> {
  const marked: Array<[string, string[]]> = [];
  for (const [kind, ids] of byKind(items)) {
    const r = await platform().dispositions.markGone(orgId, userId, kind, ids, { how: "gone", note }, { quiet: true });
    if (!r.ok) {
      for (const [k, done] of marked) await platform().dispositions.bringBack(orgId, userId, k, done, { quiet: true });
      throw new ActionRefusal(r.error);
    }
    marked.push([kind, ids]);
  }
}

/** List again everything a run marked gone; refuses (writing nothing more) if
 *  the door says no. Returns how many came back. */
export async function bringAllBack(orgId: string, userId: string | null, items: readonly GoneRef[]): Promise<number> {
  let back = 0;
  for (const [kind, ids] of byKind(items)) {
    const r = await platform().dispositions.bringBack(orgId, userId, kind, ids, { quiet: true });
    if (!r.ok) throw new ActionRefusal(r.error);
    back += r.done.length;
  }
  return back;
}

/** Set a record's count from `before` to `after`, as a correction on its lots:
 *  what is there, never a use. Taking stock down uses the oldest lots first. */
export async function setCount(orgId: string, userId: string | null, c: CountChange, source: CountSource, reason: string): Promise<void> {
  const delta = c.after - c.before;
  if (!delta) return;
  const result = await withBatches(orgId, c.id, reason, delta, (batches) => (delta < 0 ? consumeOldest(batches, -delta).batches : batches), {
    userId,
    correction: true,
    sourceKind: source.kind,
    sourceId: source.id,
  });
  if (!actionActed(result)) throw new ActionRefusal(`The count for ${c.title || "this record"} could not be changed. Check its stock and usage tracker, then try again.`);
}

/** Put a count back the way it was before `setCount`. */
export function unsetCount(orgId: string, userId: string | null, c: CountChange, source: CountSource, reason: string): Promise<void> {
  return setCount(orgId, userId, { ...c, before: c.after, after: c.before }, source, reason);
}

/** An Undo of a run never takes away a later change of someone else's (#8474):
 *  a record the run touched that another person changed after the run's own
 *  entry refuses the Undo, saying what changed, as an issued Undo does
 *  (#7924). A run with no entry of its own is judged as before. */
export async function refuseOverLaterChange(orgId: string, userId: string | null, run: { entityId: string; action: string }, ids: readonly string[]): Promise<void> {
  const after = await platform().activity.entryOf(orgId, run);
  if (after == null) return;
  const since = await platform().activity.changeSince(orgId, { ids, after, userId });
  if (since) throw new ActionRefusal(since);
}
