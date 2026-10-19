// Remove a queued label (labels:remove-queued-label): the handler its manifest entry names. Wired in ./index.ts.
// The queue's own remove (DELETE /queue/:id), on the asker's own queue.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { LabelsDB } from "../db.js";
import { findQueued } from "./queued-label-lookup.js";
import { removeQueued } from "./queue.js";

export function registerRemoveQueuedLabelAction(): void {
  platform().actions.registerHandler("labels.remove-queued-label", async (ctx) => {
    if (!ctx.userId) return { ok: false, error: "A label queue belongs to a person; there is none here." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<LabelsDB>;
    const label = await findQueued(db, ctx.userId, ctx.args?.label);
    if ("error" in label) return { ok: false, error: label.error };
    const row = await removeQueued(db as never, ctx.userId, label.id);
    if (!row) return { ok: true, skipped: true, summary: "That label already left the queue." };
    return { ok: true, summary: `Took ${row.description || "the label"} off the print queue.`, data: { label: row.id } };
  });
}
