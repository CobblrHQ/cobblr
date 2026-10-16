import { productName } from "../platform/product-name.js";
import { Router, type Request } from "express";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { platform, uploadOne } from "@cobblr/platform-contract";
import { uploadedFile } from "@cobblr/platform-contract/upload";
import { readSendFile, SEND_FILE_MAX_BYTES } from "@cobblr/platform-contract/send-file";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { requireRole } from "../auth/capability.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { SendError } from "../platform/record-send.js";
import { exportSendFile, downloadSendFile } from "../platform/record-send-file.js";
import { importSendFile, undoSendFileImport, receiptForImport } from "../platform/record-send-import.js";
import { confirmSendFile, restoreSendFileSource } from "../platform/record-send-file-confirm.js";
import { linkOrigin } from "../platform/link-origin.js";
import { SendBody } from "./record-send.js";

export const ExportFileBody = SendBody.omit({target_org: true, collection: true, field_map: true, location: true, placement: true, duplicate: true, create_matching: true, add_fields: true});
export const ImportFileBody = SendBody.omit({target_org: true, entity_kind: true, ids: true, mode: true, include_secrets: true}).extend({packet: z.unknown().optional(), file_id: z.string().uuid().optional()});
export async function sendFileInput(orgId: string, body: {packet?: unknown; receipt?: unknown; file_id?: string}, req?: Request): Promise<unknown> {
  const upload = req && uploadedFile(req);
  let text: string | undefined;
  if (upload) text = await readFile(upload.path,"utf8");
  else if (body.file_id) {
    const got = await platform().files.read(orgId,body.file_id,"original");
    if (!got) throw new SendError("That uploaded file is not in this workspace.");
    if (got.bytes.byteLength > SEND_FILE_MAX_BYTES) throw new SendError("This send file is over 64 MB. Send fewer items together.");
    text = Buffer.from(got.bytes).toString("utf8");
  }
  if (text !== undefined) {try {return JSON.parse(text);} catch {throw new SendError(`This file cannot be read. Download it again from the sending ${productName()}.`);}}
  return body.packet ?? body.receipt;
}
export function parseSendFile(input: unknown) {try {return readSendFile(input);} catch (e) {throw new SendError((e as Error).message);}}
export const recordSendFileRouter = Router();
const upload = uploadOne({field: "file", maxBytes: SEND_FILE_MAX_BYTES});
const refused = (err: unknown, res: import("express").Response, next: import("express").NextFunction) => {
  if (err instanceof SendError || err instanceof z.ZodError) {res.status(409).json({error: {code: "send_file_refused",message: err.message}}); return;}
  next(err);
};
// UI-SCREEN: /machines
// AI-ACTION: platform:export-send-file
// GATE: open to guests as well (a guest may export what they can read to a file), which a role floor cannot say since a guest never runs by role; the same exception as platform:send-records
recordSendFileRouter.post("/:slug/records/send/file",requireAuth,withTenant,async (req,res,next) => {
  if (!requireRole(req,res,"guest")) return;
  try {res.json(await exportSendFile(req.tenant!.org.id,req.session!.id,ExportFileBody.parse(req.body),linkOrigin(req)));} catch (err) {refused(err,res,next);}
});
recordSendFileRouter.get("/:slug/records/send/file/:id/download",requireAuth,withTenant,async (req,res,next) => {
  try {const file = await downloadSendFile(req.tenant!.org.id,req.session!.id,String(req.params.id)); res.attachment(`cobblr-send-${file.id}.json`).type("application/json").send(JSON.stringify(file));} catch (err) {refused(err,res,next);}
});
// UI-SCREEN: /scan
// AI-ACTION: platform:import-send-file
recordSendFileRouter.post("/:slug/records/send/file/import",requireAuth,withTenant,upload,async (req,res,next) => {
  if (!(await requireCapability(req, res, "platform:import-send-file"))) return;
  try {const p = ImportFileBody.parse(req.body); const packet = parseSendFile(await sendFileInput(req.tenant!.org.id,p,req)); res.json(await importSendFile(req.tenant!.org.id,req.session!.id,{...p,packet},linkOrigin(req)));} catch (err) {refused(err,res,next);}
});
// UI-SCREEN: /scan
// AI-ACTION: platform:undo-send-file-import
recordSendFileRouter.post("/:slug/records/send/file/imports/:id/undo",requireAuth,withTenant,async (req,res,next) => {
  if (!(await requireCapability(req, res, "platform:undo-send-file-import"))) return;
  try {res.json(await undoSendFileImport(req.tenant!.org.id,req.session!.id,String(req.params.id),req.body?.dry_run === true));} catch (err) {refused(err,res,next);}
});
// UI-SCREEN: /scan
// AI-ACTION: platform:confirm-send-file
// GATE: open to guests as well (a guest may confirm a file they were sent arrived), which a role floor cannot say since a guest never runs by role; the same exception as platform:send-records
recordSendFileRouter.post("/:slug/records/send/file/confirm",requireAuth,withTenant,upload,async (req,res,next) => {
  if (!requireRole(req,res,"guest")) return;
  try {res.json(await confirmSendFile(req.tenant!.org.id,req.session!.id,await sendFileInput(req.tenant!.org.id,req.body,req),req.body?.dry_run === true));} catch (err) {refused(err,res,next);}
});
// UI-SCREEN: /scan
// AI-ACTION: platform:restore-send-file-source
recordSendFileRouter.post("/:slug/records/send/file/restore",requireAuth,withTenant,upload,async (req,res,next) => {
  if (!(await requireCapability(req, res, "platform:restore-send-file-source"))) return;
  try {res.json(await restoreSendFileSource(req.tenant!.org.id,req.session!.id,await sendFileInput(req.tenant!.org.id,req.body,req),req.body?.dry_run === true));} catch (err) {refused(err,res,next);}
});

recordSendFileRouter.get("/:slug/records/send/file/imports/:id/receipt/:phase",requireAuth,withTenant,async (req,res,next) => {
  try {if (req.params.phase !== "imported" && req.params.phase !== "undone") throw new SendError("Choose an import confirmation or a return file."); const receipt = await receiptForImport(req.tenant!.org.id,req.session!.id,String(req.params.id),req.params.phase);res.attachment(`cobblr-${receipt.phase === "undone" ? "return" : "confirmation"}-${receipt.file_id}.json`).type("application/json").send(JSON.stringify(receipt));} catch (err) {refused(err,res,next);}
});
