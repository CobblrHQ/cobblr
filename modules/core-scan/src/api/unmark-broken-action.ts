// Take a broken mark back (core-scan:unmark-broken, #6889): the undo of
// core-scan:mark-broken. It is the scan's own Undo (POST /inbox/:id/unconfirm),
// so the repair entry comes off and the scan is back in the inbox exactly as
// the card's Undo does it. Wired in ./index.ts.
import { platform } from "@cobblr/platform-contract";
import { door, itemId } from "./undo-split-action.js";

export function registerUnmarkBrokenAction(): void {
  platform().actions.registerHandler("core-scan.unmark-broken", async (ctx) => {
    const id = itemId(ctx);
    if (!id) return { ok: false, error: "Say which scan: item_id, the one marked broken." };
    const { http } = await door(ctx);
    if (!http) return { ok: false, error: "Nobody to take it back as: sign in again." };
    // EGRESS: own-api - the scan's own Undo route on this instance, as the signed-in member
    const r = await fetch(`${http.baseUrl}/api/v1/orgs/${http.slug}/modules/core-scan/inbox/${encodeURIComponent(id)}/unconfirm`, { method: "POST", headers: http.headers, body: "{}" });
    const body = (await r.json().catch(() => null)) as { note?: string | null; error?: { message?: string } } | null;
    if (!r.ok) return { ok: false, error: body?.error?.message ?? "The scan could not be taken back." };
    return { ok: true, summary: body?.note ?? "The repair entry is off and the scan is back in the inbox.", data: { item_id: id } };
  });
}
