import { requireRole } from "../auth/capability.js";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { DeletedRecordError, deleteForever, listDeleted, restoreEntry } from "../platform/deleted-records.js";

export const deletedRecordsRouter = Router({ mergeParams: true });
deletedRecordsRouter.use(requireAuth, withTenant, (req, res, next) => { if (requireRole(req, res, "owner", "admin", "member")) next(); });
deletedRecordsRouter.get("/", async (req, res, next) => {
  try {
    const offset = z.coerce.number().int().min(0).max(100_000).default(0).parse(req.query.offset);
    res.json(await listDeleted(req.tenant!.org.id, req.session!.id, req.tenant!.role, offset, typeof req.query.kind === "string" ? req.query.kind : undefined));
  } catch (err) { next(err); }
});
// AI-REACH: action platform:restore-deleted-record
deletedRecordsRouter.post("/:id/restore", async (req, res, next) => {
  try {
    if (!await restoreEntry(req.tenant!.org.id, z.string().uuid().parse(req.params.id))) throw new DeletedRecordError(404, "That record is no longer in Recently deleted.");
    res.json({ ok: true });
  } catch (err) { if (err instanceof DeletedRecordError) res.status(err.status).json({ error: { code: "restore_refused", message: err.message } }); else next(err); }
});

// UI-SCREEN: /configuration/recently-deleted
// AI-REACH: exempt irreversible removal is chosen by a person in Recently deleted
deletedRecordsRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteForever(req.tenant!.org.id, z.string().uuid().parse(req.params.id), req.session!.id, req.tenant!.role);
    res.status(204).end();
  } catch (err) { if (err instanceof DeletedRecordError) res.status(err.status).json({ error: { code: "purge_refused", message: err.message } }); else next(err); }
});
