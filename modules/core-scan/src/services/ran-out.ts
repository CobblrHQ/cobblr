// Ran out (#6526). The owner: "I just ran out of this, Cobblr doesn't know
// about it yet, and I have yet to get more." A thing filed from a scan, or one
// already kept, is taken to 0 through the same Used it up take a person's
// count makes (the quantity door, ledgered as use), so a restock rule sees
// the same crossing from some to none, and it goes on the shopping list
// through the list's own add-item. Nothing here is a new restock mechanism.

import { platform } from "@cobblr/platform-contract";
import { actionActed } from "@cobblr/platform-contract/action-result";
import { SHOPPING_LIST_DOOR, scanCountLedgerReason } from "@cobblr/platform-contract/scan-count";
import { moveQuantity, type QuantityDoor, type QuantityMove, type ScanTarget } from "./scan-target.js";

/** What Ran out left on the row: the list line it added, for Undo. */
export const RAN_OUT_KEY = "ran_out";

export interface RanOutStamp {
  /** The list line add-item made, withdrawn by Undo; null when none was made. */
  list_item_id: string | null;
  at: string;
}

export interface RanOutOutcome {
  /** The take reached the record (it is at none now). */
  took: boolean;
  on_list: boolean;
  /** The list asked which list (no shopping list chosen yet). */
  needs_list: boolean;
  /** Why it is not on the list, in the list's own words. */
  list_note: string | null;
  move: QuantityMove | null;
  stamp: RanOutStamp;
}

/** Take what is left as used up, then put it on the shopping list. */
export async function ranOut(o: {
  orgId: string;
  userId: string | null;
  target: ScanTarget;
  entity: { kind: string; id: string };
  current: number;
  rowId: string;
  door: QuantityDoor;
  /** The one on hand was filed only so it could come off (a new thing): its
   *  take is a correction labelled "ran out", which the burn rate, usage
   *  figures and cost per use skip, never a use nobody made. The crossing to
   *  none still fires a restock rule (stock.changed is the same). */
  invented?: boolean;
}): Promise<RanOutOutcome> {
  let move: QuantityMove | null = null;
  if (o.current > 0) {
    move = await moveQuantity(o.orgId, o.target, o.entity, -o.current, {
      userId: o.userId,
      ...(o.invented ? { correction: true, reason: "ran out" } : { reason: scanCountLedgerReason({ change: -o.current, correction: false, reason: "used_up" }) }),
      source: { kind: "core-scan:inbox", id: o.rowId },
      door: o.door,
      current: o.current,
    });
  }
  const took = o.current <= 0 || !!move?.ok;
  const listed = await addToShoppingList(o.orgId, o.userId, o.entity);
  return {
    took,
    on_list: listed.itemId !== null || listed.already,
    needs_list: listed.needsList,
    list_note: listed.note,
    move,
    stamp: { list_item_id: listed.itemId, at: new Date().toISOString() },
  };
}

async function addToShoppingList(
  orgId: string,
  userId: string | null,
  entity: { kind: string; id: string },
): Promise<{ itemId: string | null; already: boolean; needsList: boolean; note: string | null }> {
  type Answer = { ok?: boolean; added?: boolean; itemId?: unknown; needs_list?: boolean; lists?: Array<{ id: string }>; skipped?: boolean; error?: string } | null;
  const ask = (args: Record<string, unknown>): Promise<Answer> =>
    platform().actions.invoke(SHOPPING_LIST_DOOR.action, {
      orgId,
      userId: userId ?? undefined,
      entity,
      event: {
        name: "core-scan.ran-out",
        payload: {},
        actor: { user_id: userId, display_name: null, auth_method: "session" },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      args,
    } as never) as Promise<Answer>;
  let r: Answer;
  try {
    r = await ask({});
    // The list asks which list for a thing it has never put on one, which a
    // thing you just ran out of always is. A workspace with one list has
    // answered already; with several, the person chooses (never a guess).
    if (r?.needs_list && r.lists?.length === 1) r = await ask({ listId: r.lists[0]!.id });
  } catch (err) {
    // A workspace without Lists has no list to go on; anything else is said.
    return { itemId: null, already: false, needsList: false, note: `Not on a shopping list: ${(err as Error).message}` };
  }
  if (r?.ok && typeof r.itemId === "string") return { itemId: r.itemId, already: false, needsList: false, note: null };
  if (r?.skipped) return { itemId: null, already: true, needsList: false, note: r.error ?? null };
  return { itemId: null, already: false, needsList: !!r?.needs_list, note: r?.error ?? null };
}

/** Undo's half: the list line Ran out added comes off (an unticked one only;
 *  a ticked line is somebody's record of buying it). */
export async function withdrawRanOut(orgId: string, userId: string | null, stamp: unknown): Promise<void> {
  const s = stamp as Partial<RanOutStamp> | null;
  if (!s || typeof s.list_item_id !== "string") return;
  const r = await platform().actions.invoke("lists:withdraw-item", {
    orgId,
    userId: userId ?? undefined,
    event: {
      name: "core-scan.ran-out.undo",
      payload: {},
      actor: { user_id: userId, display_name: null, auth_method: "session" },
      timestamp: new Date().toISOString(),
      trigger_type: "user-invoked",
    },
    args: { item_id: s.list_item_id },
  } as never);
  if (!actionActed(r)) throw new Error((r as { error?: string } | null)?.error ?? "the list kept the line");
}
