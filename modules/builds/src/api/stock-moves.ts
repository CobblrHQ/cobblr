// A stock move this module makes, and what became of it. Inventory answers a
// refused move with { ok: false } and a failed one by throwing, so the answer
// has to be read: three call sites caught the throw, logged it, and went on to
// say the build had added its output and the reversal had given its parts back.

import { platform } from "@cobblr/platform-contract";

export const OUTPUT_PART_GONE = "The part this build makes is no longer here, so what it makes would have nowhere to go. Choose what it makes, then build. Nothing moved.";

export type StockMove = { ok: true } | { ok: false; error: string };

export async function moveStock(m: {
  orgId: string;
  userId: string | null;
  partId: string;
  delta: number;
  reason: string;
  event: string;
  at?: string;
  /** Keyed to what asked, so asking again moves nothing. */
  once?: { sourceKind: string; sourceId: string };
}): Promise<StockMove> {
  try {
    const answer = (await platform().actions.invoke("inventory:adjust-stock", {
      orgId: m.orgId,
      userId: m.userId,
      entity: { kind: "inventory:part", id: m.partId },
      event: {
        name: m.event,
        payload: {},
        actor: { user_id: m.userId, display_name: null, auth_method: "session" },
        timestamp: m.at ?? new Date().toISOString(),
        trigger_type: "event",
      },
      args: { partId: m.partId, delta: m.delta, reason: m.reason, ...(m.once ? { once: true, ...m.once } : {}) },
    })) as { ok?: boolean; error?: string } | null;
    if (answer?.ok === false) return { ok: false, error: answer.error || "Inventory refused the change." };
    return { ok: true };
  } catch (e) {
    console.error(`[builds] ${m.reason} failed:`, (e as Error).message);
    return { ok: false, error: "Inventory could not be reached." };
  }
}

export async function outputPartIsHere(orgId: string, partId: string): Promise<boolean> {
  return !!(await platform().entities.lookup(orgId, "inventory:part", partId));
}
