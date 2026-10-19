import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { DigifabDB } from "../../db.js";
import { buildDriverById } from "../../jobs-core.js";
import { ReviewRequired } from "../../drivers/job-review.js";
import { parseCncProgram } from "./cnc-program.js";
import { cncPlacement } from "./cnc-placement.js";
import { requireCncStock } from "./cnc-stock.js";

export const CncPlacementBody = z.object({ stock_id: z.string().uuid(), tools: z.array(z.object({ number: z.number().int().min(1).max(9999), partId: z.string().uuid() })).min(1).max(100) });
const PlacementAction = CncPlacementBody.extend({ job_id: z.string().uuid() });

export async function placeCncProgram(db: Kysely<DigifabDB>, orgId: string, jobId: string, body: z.infer<typeof CncPlacementBody>) {
  const job = await db.selectFrom("digifab_jobs").select(["file_id", "connection_id", "status"]).where("id", "=", jobId).executeTakeFirst();
  if (!job?.file_id || !job.connection_id || job.status !== "queued") throw new ReviewRequired("Choose a queued posted CNC program before finding sheet area.");
  const driver = await buildDriverById(db, orgId, job.connection_id);
  if (await driver?.jobReviewKind?.() !== "cnc") throw new ReviewRequired("Choose a CNC connection for this posted program.");
  const file = await platform().files.read(orgId, job.file_id);
  if (!file) throw new ReviewRequired("The posted CNC file is unavailable. Choose its stored program again.");
  const stock = await requireCncStock(orgId, body.stock_id);
  const bits = await Promise.all([...new Set(body.tools.map(tool => tool.partId))].map(id => requireCncStock(orgId, id)));
  try {
    const program = parseCncProgram(Buffer.from(file.bytes).toString("utf8"));
    if (program.tools.length !== body.tools.length) throw new Error("Match every posted tool once before finding sheet area.");
    const diameters = program.tools.map(tool => {
      const chosen = body.tools.filter(item => item.number === tool.number);
      const bit = chosen.length === 1 ? bits.find(item => item.id === chosen[0]!.partId) : undefined;
      if (!bit || bit.shape !== "wearing_tool" || !bit.diameter || tool.diameter !== null && Math.abs(bit.diameter - tool.diameter) > 0.01) throw new Error(`Choose the matching library bit for tool ${tool.number}.`);
      return bit.diameter;
    });
    return cncPlacement(program, stock, diameters);
  } catch (e) { throw new ReviewRequired(e instanceof Error ? e.message : "This program does not fit the sheet's free area."); }
}

export function registerCncPlacementAction(): void {
  platform().actions.registerUndo("digifab.place-program", () => null);
  platform().actions.registerHandler("digifab.place-program", async ctx => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "An owner or admin places a CNC program on sheet stock." };
    const args = ctx.args ?? {}, parsed = PlacementAction.safeParse({ ...args, tools: readJsonArg(args, "tools") ?? args.tools });
    if (!parsed.success) return { ok: false, error: "Choose the queued program, sheet stock and every library tool." };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
    try { return { ok: true, changed: false, data: await placeCncProgram(db, ctx.orgId, parsed.data.job_id, parsed.data) }; }
    catch (e) { if (!(e instanceof ReviewRequired)) throw e; return { ok: false, error: e.message }; }
  });
}
