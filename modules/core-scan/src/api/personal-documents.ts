import { Router } from "express";
import { readFile } from "node:fs/promises";
import { uploadOne } from "@cobblr/platform-contract";
import { uploadedFile } from "@cobblr/platform-contract/upload";
import { readPersonalDocument } from "@cobblr/platform-contract/personal-documents";
import { asyncHandler, requireRole } from "./util.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { attachPaperwork } from "../services/attach-paperwork.js";
import { tenantContext, sessionUser } from "../db.js";
import { readPersonalBillOfSale } from "../services/personal-bill-of-sale.js";
import { keepInVault } from "../services/vault-original.js";
import { fileReceiptRead } from "./inbox.js";

export const personalDocumentsRouter = Router({ mergeParams: true });
// AI-REACH: exempt personal documents never reach a model through the assistant; this multipart door returns only locally extracted fields to the person
personalDocumentsRouter.post("/personal-documents/read", uploadOne({ personalDocument: true, maxBytes: 25 * 1024 * 1024 }), asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const file = uploadedFile(req);
  if (!file) { res.status(400).json({ error: { code: "missing_file", message: "Choose a document to read." } }); return; }
  const read = await readPersonalDocument({ bytes: await readFile(file.path), mime: file.mimetype, path: file.path, vault: true,
    assist: { orgId: tenantContext(req).org.id, userId: sessionUser(req).id } });
  res.setHeader("Cache-Control", "no-store");
  res.json(read);
}));

// A bill of sale files its vehicle purchase (#5331): read on the personal
// path (code first; an AI only for what code could not read, and only the
// one this workspace allows), then filed as a receipt is, with no original
// kept: one inbox item for the vehicle, offered against the car already here
// (by VIN, then plate, then name), and its purchase with the fees and tax as
// charges. With `kind` and `id` it goes on a record that exists instead: the
// record's empty fields are filled (never one a person typed) and the
// purchase recorded, as a paste of any paperwork is.
// AI-REACH: exempt personal documents never reach a model through the assistant; the person uploads the page here, and what was read is filed as an ordinary inbox item and purchase the assistant can then see
personalDocumentsRouter.post("/personal-documents/bill-of-sale", uploadOne({ personalDocument: true, maxBytes: 25 * 1024 * 1024 }), asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const file = uploadedFile(req);
  if (!file) { res.status(400).json({ error: { code: "missing_file", message: "Choose a bill of sale to read." } }); return; }
  // On a record that exists (the car's own page): fill it and record the
  // purchase, as a paste of any paperwork does, with nothing attached.
  const onRecord = typeof req.body?.kind === "string" && typeof req.body?.id === "string" && /^[0-9a-f-]{36}$/i.test(req.body.id) ? { kind: String(req.body.kind), id: String(req.body.id) } : null;
  if (onRecord && !(await requireCapability(req, res, "core-scan:attach-paperwork"))) return;
  // The VIN the person typed when the page's would not read (#5921).
  const typedVin = typeof req.body?.vin === "string" && req.body.vin.trim() ? req.body.vin.trim().slice(0, 40) : undefined;
  const read = await readPersonalBillOfSale({ bytes: await readFile(file.path), mime: file.mimetype, path: file.path, orgId: tenantContext(req).org.id, userId: sessionUser(req).id, ...(typedVin ? { vin: typedVin } : {}) });
  res.setHeader("Cache-Control", "no-store");
  if (!read.ok) { res.status(422).json({ error: { code: read.code, message: read.message } }); return; }
  // The original, into the Vault of whoever brought it: on the record when it
  // is known, linked by "It's this one" otherwise.
  const vault = await keepInVault(tenantContext(req).org.id, sessionUser(req).id, { name: file.originalname || "Bill of sale", mimeType: file.mimetype, bytes: await readFile(file.path), record: onRecord });
  // Who read it travels with the result, so the card can say so.
  const said = {
    read_by: read.read_by,
    ...(read.sent_to ? { sent_to: read.sent_to } : {}),
    vault: vault.kept ? { kept: true, folder: vault.folderName } : { kept: false, why: vault.why },
  };
  const out = { status: (code: number) => ({ json: (body: unknown) => res.status(code).json({ ...(body as object), ...said }) }) };
  if (onRecord) {
    const result = await attachPaperwork({ orgId: tenantContext(req).org.id, userId: sessionUser(req).id, fileId: null, kind: onRecord.kind, id: onRecord.id, http: null, receipt: read.result.receipt });
    res.json({ ...result, ...said });
    return;
  }
  await fileReceiptRead(req as never, out as never, { file_id: null, vault_file_id: vault.kept ? vault.fileId : null, origin: "upload", force: req.body?.force === "true" }, read.result);
}));
