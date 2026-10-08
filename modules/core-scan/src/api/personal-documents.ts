import { Router } from "express";
import { readFile } from "node:fs/promises";
import { uploadOne } from "@cobblr/platform-contract";
import { uploadedFile } from "@cobblr/platform-contract/upload";
import { readPersonalDocument } from "@cobblr/platform-contract/personal-documents";
import { asyncHandler, requireRole } from "./util.js";
import { tenantContext, sessionUser } from "../db.js";

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
