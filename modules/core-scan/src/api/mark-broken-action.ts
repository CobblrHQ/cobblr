// Mark a scan broken (core-scan:mark-broken, #6889): "the drill I just scanned
// is broken". The assistant's door to what the card's and the camera sheet's
// Broken mark do (services/mark-broken.ts): one repair entry on the thing the
// scan matched, no new thing, the scan settled. Its undo, core-scan:unmark-broken,
// is the scan's own Undo (POST /inbox/:id/unconfirm), so the entry comes off
// and the scan is back in the inbox whichever door took it back. Wired in
// ./index.ts.
import { platform } from "@cobblr/platform-contract";
import { markBroken } from "../services/mark-broken.js";
import { door, itemId } from "./undo-split-action.js";

export function registerMarkBrokenAction(): void {
  platform().actions.registerHandler("core-scan.mark-broken", async (ctx) => {
    const id = itemId(ctx);
    if (!id) return { ok: false, error: "Say which scan: item_id, from the scan inbox." };
    const note = typeof (ctx.args as { note?: unknown } | null)?.note === "string" ? String((ctx.args as { note: string }).note).trim().slice(0, 500) || null : null;
    const { db } = await door(ctx);
    const r = await markBroken(db, ctx.orgId, ctx.userId ?? null, id, note);
    if (!r.ok) return { ok: false, error: r.message };
    return { ok: true, summary: `${r.record.title} needs repair: it is in its service log.`, data: { item_id: id, entry_id: r.entry_id, record: r.record } };
  });
  platform().actions.registerUndo("core-scan.mark-broken", (result) => {
    const id = (result as { data?: { item_id?: string } } | null)?.data?.item_id;
    return id ? { action_id: "core-scan:unmark-broken", args: { item_id: id } } : null;
  });
}
