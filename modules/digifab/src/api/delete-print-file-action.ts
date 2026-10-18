// Delete a print file (digifab:delete-print-file): the handler its manifest entry names. Wired in ./index.ts.
// The library's delete (DELETE /library/:id): a layout's generated project, or a
// drawing a saved layout uses, is kept.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { findPrintFile } from "./job-lookup.js";
import { deleteLibraryItem } from "./library.js";

export function registerDeletePrintFileAction(): void {
  platform().actions.registerHandler("digifab.delete-print-file", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const file = await findPrintFile(db, ctx.args?.file);
    if ("error" in file) return { ok: false, error: file.error };
    const r = await deleteLibraryItem(db as never, file.id);
    if (r.status !== 200) return { ok: false, error: String((r.body.error as { message?: string } | undefined)?.message ?? "It could not be deleted.") };
    return { ok: true, summary: `Deleted ${file.name} from the print library.`, data: { file: file.id } };
  });
}
