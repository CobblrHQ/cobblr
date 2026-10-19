// Remove a label size (labels:remove-size): the handler its manifest entry names. Wired in ./index.ts.
// The sizes page's remove (DELETE /sizes/:id).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { LabelsDB } from "../db.js";
import { listSizes, removeSize } from "./sizes.js";

export function registerRemoveSizeAction(): void {
  platform().actions.registerHandler("labels.remove-size", async (ctx) => {
    const want = typeof ctx.args?.name === "string" ? ctx.args.name.trim() : "";
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<LabelsDB>;
    const sizes = await listSizes(db as never);
    const hit = sizes.find((x) => x.id === want || x.name.toLowerCase() === want.toLowerCase());
    if (!hit) return { ok: false, error: sizes.length ? `No size called "${want}". There is ${sizes.map((x) => x.name).join(", ")}.` : "There are no custom label sizes." };
    await removeSize(db as never, hit.id);
    return { ok: true, summary: `Removed the ${hit.name} label size.`, data: { size: hit.id } };
  });
}
