import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { tenantDb, tenantContext, sessionUser } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { TermBody } from "../term-fields.js";
import { presentTerms, termTotals, updateTerm, endRenewal } from "../terms-store.js";
import { present } from "./schedules.js";
import { MaintenanceRefusal } from "../refusal.js";
import { platform } from "@cobblr/platform-contract";

export const termsRouter = Router({ mergeParams: true });
const Query = z.object({ entity_id: z.string().uuid().optional(), schedule_id: z.string().uuid().optional(),
  year: z.coerce.number().int().min(1).max(9999).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) });
termsRouter.get("/", asyncHandler(async (req, res) => {
  const parsed = Query.safeParse(req.query); if (!parsed.success) return badBody(res, parsed.error);
  const d = parsed.data; const db = tenantDb(req); const orgId = tenantContext(req).org.id;
  let q = db.selectFrom("core_maintenance_entries").selectAll().where("is_term", "=", true);
  if (d.entity_id) q = q.where("entity_id", "=", d.entity_id);
  if (d.schedule_id) q = q.where("schedule_id", "=", d.schedule_id);
  if (d.year) q = q.where("performed_at", ">=", new Date(`${d.year}-01-01T00:00:00Z`)).where("performed_at", "<", new Date(`${d.year + 1}-01-01T00:00:00Z`));
  const rows = await q.orderBy(sql`case when term_start <= now() and term_end > now() then 0 when term_start > now() then 1 else 2 end`).orderBy(sql`term_end desc nulls last`).orderBy("performed_at", "desc").orderBy("id").limit(d.limit + 1).offset(d.offset).execute();
  res.json({ items: await platform().entities.withFieldLabels(orgId, "core-maintenance:term", await presentTerms(orgId, rows.slice(0, d.limit))), has_more: rows.length > d.limit,
    totals: await termTotals(db, orgId, d.entity_id, d.schedule_id, { userId: sessionUser(req).id, role: tenantContext(req).role }) });
}));
termsRouter.get("/:id", asyncHandler(async (req, res) => {
  const row = await tenantDb(req).selectFrom("core_maintenance_entries").selectAll().where("id", "=", String(req.params.id)).where("is_term", "=", true).executeTakeFirst();
  if (!row) throw new MaintenanceRefusal("Term not found", 404);
  const orgId = tenantContext(req).org.id;
  res.json((await platform().entities.withFieldLabels(orgId, "core-maintenance:term", await presentTerms(orgId, [row])))[0]);
}));
// AI-ACTION: core-maintenance:update-term
// UI-SCREEN: /instances/:name, Edit term saves through core-maintenance:update-term so the correction carries its Undo
termsRouter.patch("/:id", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-maintenance:update-term"))) return;
  const d = TermBody.safeParse(req.body); if (!d.success) return badBody(res, d.error);
  res.json(await updateTerm(tenantDb(req), tenantContext(req).org.id, String(req.params.id), d.data));
}));
/** The route's body; its gate is the route's own (index.ts). */
export async function endRenewalRoute(req: import("express").Request, res: import("express").Response) {
  const row = await endRenewal(tenantDb(req), String(req.params.id), sessionUser(req).id);
  res.json(await present(tenantContext(req).org.id, row));
}
