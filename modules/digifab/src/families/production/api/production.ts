import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { readListPage, pagedAnswer, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { likeEscape } from "@cobblr/platform-contract";
import { tenantDb, tenantContext, sessionUser } from "../../../db.js";
import { asyncHandler, requireRole } from "../../../api/util.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { productionMutation, productionControl, exportProductionReport } from "../production-actions.js";
export const productionRouter = Router({ mergeParams: true });
productionRouter.get("/:collection", asyncHandler(async (req, res) => {
 if (!requireRole(req, res, "member")) return;
 const page = readListPage(req.query, 30), db = tenantDb(req), collection = req.params.collection;
 if (collection === "plans") {
  const rows = await db.selectFrom("digifab_test_plan_versions as v").innerJoin("digifab_test_plans as h", j => j.onRef("h.id", "=", "v.plan_id").onRef("h.latest_version", "=", "v.version")).selectAll("v").select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).orderBy("v.created_at", "desc").orderBy("v.plan_id", "asc").limit(page.limit).offset(page.offset).execute();
  return void res.json(pagedAnswer(rows, page));
 }
 if (collection === "jigs") {
  const rows = await db.selectFrom("digifab_test_jigs").selectAll().select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).orderBy("name", "asc").orderBy("asset_id", "asc").limit(page.limit).offset(page.offset).execute(); return void res.json(pagedAnswer(rows, page));
 }
 if (collection === "units") {
  const q = z.string().max(160).parse(req.query.q ?? "");
  let query = db.selectFrom("digifab_test_units").selectAll().select(sql<string>`count(*) over()`.as(TOTAL_COLUMN));
  if (q) query = query.where("serial", "ilike", `%${likeEscape(q)}%`);
  const rows = await query.orderBy("created_at", "desc").orderBy("unit_id", "asc").limit(page.limit).offset(page.offset).execute(); return void res.json(pagedAnswer(rows, page));
 }
 if (collection === "runs") {
  const rows = await db.selectFrom("digifab_test_runs as r").leftJoin("digifab_test_delivery as d", "d.run_id", "r.id").selectAll("r").select(["d.last_error", "d.acknowledged"]).select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).orderBy("r.prepared_at", "desc").orderBy("r.id", "asc").limit(page.limit).offset(page.offset).execute(); return void res.json(pagedAnswer(rows, page));
 }
 res.status(404).json({ error: { message: "Choose plans, jigs, units or runs." } });
}));
// AI-ACTION: digifab:production-test
// UI-SCREEN: /digifab/production saves plans, jigs and units, prepares, syncs and exports through the digifab:production-test action
productionRouter.post("/", asyncHandler(async (req, res) => {
 if (!(await requireCapability(req, res, "digifab:production-test"))) return;
 const input = z.object({ operation: z.string().max(40), fields: z.unknown() }).strict().parse(req.body);
 try { res.json(input.operation === "export" ? await exportProductionReport(tenantDb(req), tenantContext(req).org.id, input.fields) : await productionMutation(tenantDb(req), tenantContext(req).org.id, sessionUser(req)!.id, input.operation, input.fields)); }
 catch (error) { res.status(409).json({ error: { message: error instanceof Error ? error.message : "Production test could not finish." } }); }
}));
// AI-ACTION: digifab:production-control, digifab:production-abort
// UI-SCREEN: /station/production/:connectionId starts, answers and aborts through the digifab:production-control and digifab:production-abort actions
productionRouter.post("/control", asyncHandler(async (req, res) => {
 // Abort is every member's stop; starting an attempt or answering its prompt runs the station, the operator's (#6785).
 const aborting = (req.body as { operation?: unknown } | undefined)?.operation === "abort";
 if (aborting ? !(await requireCapability(req, res, "digifab:production-abort")) : !(await requireCapability(req, res, "digifab:production-control"))) return;
 const input = z.object({ operation: z.enum(["start", "answer", "abort"]), fields: z.unknown() }).strict().parse(req.body);
 try { res.json(await productionControl(tenantDb(req), tenantContext(req).org.id, input.operation, input.fields)); }
 catch (error) { res.status(409).json({ error: { message: error instanceof Error ? error.message : "The station could not finish this action." } }); }
}));
