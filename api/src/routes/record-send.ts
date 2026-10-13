import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { SendError, previewSend, sendRecords, sendTargets, undoSend } from "../platform/record-send.js";

export const SendBody = z.object({
  entity_kind: z.string().min(1).max(120), ids: z.array(z.string().uuid()).min(1).max(200),
  connection_id: z.string().uuid().optional(), // none-refused-ok: the send packet is a typed input shared with the record-send action and file route, which take no null
  target_org: z.string().min(1).max(120), collection: z.string().max(120).nullable().optional(),
  mode: z.enum(["copy", "move"]), field_map: z.record(z.string().nullable()).optional(),
  placement: z.literal("unplaced").optional(), // none-refused-ok: the send packet is a typed input shared with the record-send action and file route, which take no null
  include_secrets: z.boolean().optional(), location: z.string().uuid().nullable().optional(),
  create_matching: z.boolean().optional(), add_fields: z.array(z.string().max(120)).max(100).optional(),
  duplicate: z.enum(["update", "another"]).optional(), request_id: z.string().uuid().optional(), dry_run: z.boolean().optional(), // none-refused-ok: the send packet is a typed input shared with the record-send action and file route, which take no null
});
export const recordSendRouter = Router();
recordSendRouter.get("/:slug/records/send-targets", requireAuth, withTenant, async (req, res, next) => {
  try { res.json(await sendTargets(req.tenant!.org.id, req.session!.id)); } catch (err) { next(err); }
});
// UI-SCREEN: /machines
// AI-ACTION: platform:send-records
// GATE: the bar depends on the mode (a move is a member's, a copy anyone's who may write), which one action declaration cannot say (#5170 lists it).
recordSendRouter.post("/:slug/records/send", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: { code: "bad_body", message: parsed.error.issues[0]?.message } }); return; }
    if (!requireRole(req, res, parsed.data.mode === "move" ? "member" : "guest")) return;
    res.json(parsed.data.dry_run ? await previewSend(req.tenant!.org.id, req.session!.id, parsed.data) : await sendRecords(req.tenant!.org.id, req.session!.id, parsed.data));
  } catch (err) {
    if (err instanceof SendError) { res.status(409).json({ error: { code: "send_refused", message: err.message } }); return; }
    next(err);
  }
});
// UI-SCREEN: /machines
// AI-ACTION: platform:undo-send
// GATE: undoing a send is its sender's own, whatever the mode was, as above (#5170).
recordSendRouter.post("/:slug/records/send/:id/undo", requireAuth, withTenant, async (req, res, next) => {
  if (!requireRole(req, res, "guest")) return;
  try { res.json(await undoSend(req.tenant!.org.id, req.session!.id, String(req.params.id), req.body?.restore_source === true)); }
  catch (err) { if (err instanceof SendError) { res.status(409).json({ error: { code: "undo_refused", message: err.message } }); return; } next(err); }
});
