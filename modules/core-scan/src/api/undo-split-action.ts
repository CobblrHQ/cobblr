// Undo split (core-scan:undo-split, #6342): the inbox card's Undo split, for
// the assistant and the MCP server too. The pieces leave the inbox (kept,
// never deleted) and the photo comes back as it was (services/undo-split.ts).
// Wired in ./index.ts.
import type { Kysely } from "kysely";
import { platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { selfOrigin } from "@cobblr/platform-contract/self-api";
import type { CoreScanDB } from "../db.js";
import { appendScanHistory } from "../services/scan-history.js";
import { undoSplit } from "../services/undo-split.js";

export async function door(ctx: ActionInvokeContext) {
  const db = (await platform().tenants.getDb(ctx.orgId)) as unknown as Kysely<CoreScanDB>;
  const slug = (await platform().orgs.get(ctx.orgId).catch(() => null))?.slug ?? "";
  const token = ctx.userId && slug ? await platform().auth.mintSession({ userId: ctx.userId }).catch(() => null) : null;
  return { db, http: token ? { baseUrl: selfOrigin(), slug, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } } : null };
}

export const itemId = (ctx: ActionInvokeContext) => (typeof (ctx.args as { item_id?: unknown } | null)?.item_id === "string" ? String((ctx.args as { item_id: string }).item_id).trim() : "");

export function registerUndoSplitAction(): void {
  platform().actions.registerHandler("core-scan.undo-split", async (ctx) => {
    const id = itemId(ctx);
    if (!id) return { ok: false, error: "Say which split: item_id, the group's or one piece's." };
    const { db, http } = await door(ctx);
    const r = await undoSplit(db, ctx.orgId, id, http);
    if (!r.ok) return { ok: false, error: r.error.message };
    await appendScanHistory(db, r.parent.id, { action: "unsplit", note: `${r.live.length} split item${r.live.length === 1 ? "" : "s"} discarded` });
    return { ok: true, summary: `Back as one photo; ${r.live.length} piece${r.live.length === 1 ? "" : "s"} taken out.`, data: { item_id: r.parent.id, discarded: r.live } };
  });
  platform().actions.registerUndo("core-scan.undo-split", (result) => {
    const id = (result as { data?: { item_id?: string } } | null)?.data?.item_id;
    return id ? { action_id: "core-scan:redo-split", args: { item_id: id } } : null;
  });
}
