import { Router, type Response } from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { z } from "zod";
import { readListPage } from "@cobblr/platform-contract/list-page";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { tenantDb, tenantContext, sessionUser } from "../../../db.js";
import { asyncHandler, badBody } from "../../../api/util.js";
import { ArmRefusal } from "../station.js";
import { readCell, saveDefinition, setOperators, setOutput, setupCell } from "../cells/store.js";
import { endCellJobByPerson, resumeCellJob, startCellJob, stopCellJob } from "../cells/run.js";
export const cellsRouter = Router({ mergeParams: true });
const Id = z.string().uuid();
function refuse(res: Response, e: unknown) {
  if (e instanceof z.ZodError) return badBody(res, e);
  if (!(e instanceof ArmRefusal)) throw e;
  res.status(409).json({ error: { code: "cell_refused", message: e.message } });
}
const admin = (req: Parameters<Parameters<typeof cellsRouter.get>[1]>[0]) => roleSatisfies((req as unknown as { tenant?: { role: string } }).tenant?.role, ["admin"]);

cellsRouter.get("/:machineId", asyncHandler(async (req, res) => {
  const page = readListPage(req.query, 20);
  res.json(await readCell(tenantDb(req), tenantContext(req).org.id, Id.parse(req.params.machineId), page));
}));
// AI-ACTION: digifab:cell-record
cellsRouter.post("/:machineId/setup", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: a cell's machines, job, operators and output are the admin tier's on the page, at every door
  if (!(await requireCapability(req, res, "digifab:cell-record"))) return;
  try { res.json(await setupCell(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:cell-record
cellsRouter.patch("/:machineId/definition", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: a cell's machines, job, operators and output are the admin tier's on the page, at every door
  if (!(await requireCapability(req, res, "digifab:cell-record"))) return;
  try { res.json(await saveDefinition(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:cell-record
cellsRouter.patch("/:machineId/operators", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: a cell's machines, job, operators and output are the admin tier's on the page, at every door
  if (!(await requireCapability(req, res, "digifab:cell-record"))) return;
  try { res.json(await setOperators(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:cell-record
cellsRouter.patch("/:machineId/output", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: a cell's machines, job, operators and output are the admin tier's on the page, at every door
  if (!(await requireCapability(req, res, "digifab:cell-record"))) return;
  try { res.json(await setOutput(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-REACH: exempt starting a cell's job runs its machines: only a person at its authorized station who checked the cell, never an assistant or a wire.
cellsRouter.post("/:machineId/jobs", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:operate"))) return;
  try { res.status(201).json(await startCellJob(tenantDb(req), tenantContext(req).org.id, Id.parse(req.params.machineId), req.body, { userId: sessionUser(req)!.id, via: "station", admin: admin(req) })); } catch (e) { refuse(res, e); }
}));
// AI-REACH: exempt resuming a cell's job runs its machines again: only a person at its authorized station, never an assistant or a wire.
cellsRouter.post("/:machineId/resume", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:operate"))) return;
  try { res.json(await resumeCellJob(tenantDb(req), tenantContext(req).org.id, Id.parse(req.params.machineId), req.body, { userId: sessionUser(req)!.id, via: "station", admin: admin(req) })); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:cell-stop
cellsRouter.post("/:machineId/stop", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:cell-stop"))) return;
  try { res.json(await stopCellJob(tenantDb(req), tenantContext(req).org.id, Id.parse(req.params.machineId), { userId: sessionUser(req)?.id ?? null, via: typeof req.body?.station_token === "string" ? "station" : "page", admin: admin(req) })); } catch (e) { refuse(res, e); }
}));
// AI-REACH: exempt closing a job the bridge no longer knows records what a person found at the cell; Cobb stops a cell with digifab:cell-stop.
cellsRouter.post("/jobs/:jobId/end", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:operate"))) return;
  try { res.json(await endCellJobByPerson(tenantDb(req), tenantContext(req).org.id, Id.parse(req.params.jobId), req.body, sessionUser(req)?.id ?? null)); } catch (e) { refuse(res, e); }
}));
