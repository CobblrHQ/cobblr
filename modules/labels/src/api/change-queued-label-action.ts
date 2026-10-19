// Change a queued label (labels:change-queued-label): the handler its manifest entry names. Wired in ./index.ts.
// The queue's own edit (PATCH /queue/:id), on the asker's own queue; nothing prints.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { LabelsDB } from "../db.js";
import { findQueued } from "./queued-label-lookup.js";
import { changeQueued } from "./queue.js";

export function registerChangeQueuedLabelAction(): void {
  platform().actions.registerHandler("labels.change-queued-label", async (ctx) => {
    if (!ctx.userId) return { ok: false, error: "A label queue belongs to a person; there is none here." };
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const qty = a.qty === undefined || a.qty === "" ? undefined : Number(a.qty);
    if (qty !== undefined && !(Number.isInteger(qty) && qty >= 1 && qty <= 99)) return { ok: false, error: "How many is a whole number from 1 to 99." };
    const caption = typeof a.caption === "string" ? a.caption.slice(0, 200) : undefined;
    if (qty === undefined && caption === undefined) return { ok: false, error: "Say how many, or the caption." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<LabelsDB>;
    const label = await findQueued(db, ctx.userId, a.label);
    if ("error" in label) return { ok: false, error: label.error };
    const row = await changeQueued(db as never, ctx.userId, label.id, { ...(qty !== undefined ? { qty } : {}), ...(caption !== undefined ? { description: caption } : {}) });
    if (!row) return { ok: false, error: "That label already left the queue." };
    return { ok: true, summary: `${row.description || "The label"}: ${row.qty} to print.`, data: { label: label.id, before: { qty: label.qty, caption: label.description ?? "" } } };
  });
  platform().actions.registerUndo("labels.change-queued-label", (result) => {
    const d = (result as { ok?: unknown; data?: { label?: string; before?: { qty: number; caption: string } } } | null);
    if (d?.ok !== true || !d.data?.label || !d.data.before) return null;
    return { action_id: "labels:change-queued-label", args: { label: d.data.label, ...d.data.before } };
  });
}
