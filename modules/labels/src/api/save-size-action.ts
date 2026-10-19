// Save a label size (labels:save-size): the handler its manifest entry names. Wired in ./index.ts.
// The sizes page's save (POST /sizes, PUT /sizes/:id): one name, one size.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { LabelsDB } from "../db.js";
import { SizeBody, listSizes, writeSize } from "./sizes.js";

export function registerSaveSizeAction(): void {
  platform().actions.registerHandler("labels.save-size", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
    const parsed = SizeBody.safeParse({
      name: a.name,
      label_w: n(a.label_w),
      label_h: n(a.label_h),
      // A roll of one label across is a sheet the size of the label.
      media_w: n(a.sheet_w) ?? n(a.label_w),
      media_h: n(a.sheet_h) ?? n(a.label_h),
      ...(n(a.margin_top) !== undefined ? { margin_t: n(a.margin_top) } : {}),
      ...(n(a.margin_left) !== undefined ? { margin_l: n(a.margin_left) } : {}),
      ...(n(a.column_gap) !== undefined ? { col_gap: n(a.column_gap) } : {}),
      ...(n(a.row_gap) !== undefined ? { row_gap: n(a.row_gap) } : {}),
    });
    if (!parsed.success) return { ok: false, error: "Give a name and the label's width and height in inches (and the sheet's, for a sheet of several)." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<LabelsDB>;
    const existing = (await listSizes(db as never)).find((x) => x.name.toLowerCase() === parsed.data.name.toLowerCase());
    if (!existing && !ctx.userId) return { ok: false, error: "A new size is saved by a person." };
    const out = await writeSize(db as never, parsed.data, existing ? { id: existing.id } : { userId: ctx.userId! });
    if (!out) return { ok: false, error: "That size is gone." };
    if ("error" in out) return { ok: false, error: out.error };
    return {
      ok: true,
      summary: `${existing ? "Changed" : "Saved"} the ${out.size.name} size: ${out.size.per_sheet} label${out.size.per_sheet === 1 ? "" : "s"} a sheet.`,
      data: existing ? { size: existing.id, before: existing } : { size: out.size.id, created: true },
    };
  });
}
