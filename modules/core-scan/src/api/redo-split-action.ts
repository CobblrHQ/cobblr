// Split again (core-scan:redo-split, #6527): the Undo split toast's way back,
// for the assistant and the MCP server too. The parts the undo took out come
// back as they were and the line goes back over them (services/undo-split.ts
// redoSplit). Its undo is Undo split. Wired in ./index.ts.
import { platform } from "@cobblr/platform-contract";
import { appendScanHistory } from "../services/scan-history.js";
import { redoSplit } from "../services/undo-split.js";
import { door, itemId } from "./undo-split-action.js";

export function registerRedoSplitAction(): void {
  platform().actions.registerHandler("core-scan.redo-split", async (ctx) => {
    const id = itemId(ctx);
    if (!id) return { ok: false, error: "Say which line to split again: item_id, the one put back as one." };
    const { db, http } = await door(ctx);
    const r = await redoSplit(db, id, http);
    if (!r.ok) return { ok: false, error: r.error.message };
    await appendScanHistory(db, r.parent.id, { action: "resplit", note: `${r.parts.length} split item${r.parts.length === 1 ? "" : "s"} back` });
    return { ok: true, summary: `Split again into ${r.parts.length}.`, data: { item_id: r.parent.id, parts: r.parts } };
  });
  platform().actions.registerUndo("core-scan.redo-split", (result) => {
    const id = (result as { data?: { item_id?: string } } | null)?.data?.item_id;
    return id ? { action_id: "core-scan:undo-split", args: { item_id: id } } : null;
  });
}
