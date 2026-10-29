// Arrived damaged (core-scan:mark-arrived-damaged, #8854): the assistant's
// door to the card's Arrived damaged mark (services/arrived-damaged.ts). Its
// undo is the scan's own Undo (POST /inbox/:id/unconfirm). Wired in ./index.ts.
import { platform } from "@cobblr/platform-contract";
import { markArrivedDamaged } from "../services/arrived-damaged.js";
import { door, itemId } from "./undo-split-action.js";

export function registerMarkArrivedDamagedAction(): void {
  platform().actions.registerHandler("core-scan.mark-arrived-damaged", async (ctx) => {
    const id = itemId(ctx);
    if (!id) return { ok: false, error: "Say which scan: item_id, from the scan inbox." };
    const note = typeof (ctx.args as { note?: unknown } | null)?.note === "string" ? String((ctx.args as { note: string }).note).trim().slice(0, 500) || null : null;
    const { db } = await door(ctx);
    const name = ctx.event?.actor?.display_name?.trim() || "Someone";
    const r = await markArrivedDamaged(db, ctx.orgId, { by: ctx.userId ?? null, by_name: name, at: new Date().toISOString() }, id, note);
    if (!r.ok) return { ok: false, error: r.message };
    const what = (r.item as { suggested_name?: string | null }).suggested_name ?? "It";
    return { ok: true, summary: `${what} is marked as arrived damaged and was not added to stock.`, data: { item_id: id, damaged: r.damaged } };
  });
  // Its undo is the scan's own Undo, the same door unmark-broken opens: the
  // mark comes off and the scan is back in the inbox.
  platform().actions.registerUndo("core-scan.mark-arrived-damaged", (result) => {
    const id = (result as { data?: { item_id?: string } } | null)?.data?.item_id;
    return id ? { action_id: "core-scan:unmark-broken", args: { item_id: id } } : null;
  });
}
