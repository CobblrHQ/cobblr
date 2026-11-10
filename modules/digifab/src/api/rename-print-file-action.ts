// Rename a print file (digifab:rename-print-file): the handler its manifest entry names. Wired in ./index.ts.
// The library's rename (PATCH /library/:id), without the laser material: that
// decides how a laser cuts and is set in the layout's plan.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { findPrintFile } from "./job-lookup.js";
import { editLibraryItem } from "./library.js";

export function registerRenamePrintFileAction(): void {
  platform().actions.registerHandler("digifab.rename-print-file", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const name = typeof a.name === "string" ? a.name.trim().slice(0, 300) : "";
    const notes = a.notes === undefined ? undefined : typeof a.notes === "string" ? a.notes.slice(0, 2000) || null : null;
    if (!name && notes === undefined) return { ok: false, error: "Say the new name or the notes." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const file = await findPrintFile(db, a.file);
    if ("error" in file) return { ok: false, error: file.error };
    // An Undo carries what the rename set; a name or notes changed since (by a
    // teammate or the renamer) stand, and nothing is written (#9427).
    const expected = a.expected as { name?: unknown; notes?: unknown } | undefined;
    if (expected && (expected.name !== file.name || (expected.notes ?? null) !== (file.notes ?? null))) {
      return { ok: false, error: `${file.name} was renamed or its notes changed since, so it stays as it is now. Nothing was changed.` };
    }
    const r = await editLibraryItem(db as never, file.id, { ...(name ? { name } : {}), ...(notes !== undefined ? { notes } : {}) });
    if (r.status !== 200) return { ok: false, error: String((r.body.error as { message?: string } | undefined)?.message ?? "It could not be changed.") };
    const now = r.body as { name?: string; notes?: string | null };
    return { ok: true, summary: name ? `${file.name} is now called ${name}.` : `Changed the notes on ${file.name}.`, data: { file: file.id, before: { name: file.name, notes: file.notes }, after: { name: now.name ?? file.name, notes: now.notes ?? null } } };
  });
  platform().actions.registerUndo("digifab.rename-print-file", (result) => {
    const d = (result as { ok?: unknown; data?: { file?: string; before?: { name: string; notes: string | null }; after?: { name: string; notes: string | null } } } | null);
    if (d?.ok !== true || !d.data?.file || !d.data.before || !d.data.after) return null;
    // UNDO: puts back the name and notes only while the file still says what the rename set (#9427)
    return { action_id: "digifab:rename-print-file", args: { file: d.data.file, name: d.data.before.name, notes: d.data.before.notes ?? "", expected: d.data.after } };
  });
}
