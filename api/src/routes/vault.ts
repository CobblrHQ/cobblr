// The Vault's routes (#5242, docs/design-decisions/vault.md). Every one asks
// the folder's access list (platform/vault.ts); a folder or file the caller
// cannot open answers 404, the same as one that does not exist.
//
// The assistant's door is deliberately narrow. Cobb and MCP may file a
// document into a folder the person owns (platform:file-into-vault) and may
// say a record has a document in the Vault, but no tool ever reads a vault
// file's bytes or lists a folder: personal documents never reach a model
// through the assistant. An API token reaches these routes only when it was
// made with the `vault` scope (auth/scopes.ts); an unscoped token, a
// connector's or one made for anything else is refused here.
import { Router, type NextFunction, type Request, type Response } from "express";
import { readFile, unlink } from "node:fs/promises";
import { uploadOne } from "@cobblr/platform-contract";
import { uploadedFile } from "@cobblr/platform-contract/upload";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { currentActor } from "../lib/request-context.js";
import {
  VAULT_MAX_BYTES,
  VaultError,
  addVaultFile,
  changeVaultFile,
  createVaultFolder,
  deleteVaultFile,
  deleteVaultFolder,
  listVaultFolders,
  readVaultFile,
  renameVaultFolder,
  setVaultFolderPeople,
  vaultDocumentsFor,
  vaultFolder,
  vaultFolderHistory,
} from "../platform/vault.js";

export const vaultRouter = Router();
// The Vault is where a personal document belongs, so the door's personal
// check (which turns one away from shared Files) lets it through here.
const upload = uploadOne({ field: "file", maxBytes: VAULT_MAX_BYTES, personalDocument: true });

/** A token reaches the Vault only when made for it; the app's own session
 *  always may (the folder's list still decides). */
function vaultDoor(req: Request, res: Response, next: NextFunction) {
  if ((req.session?.api_token_id || currentActor()?.apiTokenId) && !req.session?.token_scopes?.includes("vault")) {
    res.status(403).json({ error: { code: "missing_scope", message: "The Vault opens to an API token only when it was made with the vault scope." } });
    return;
  }
  next();
}

const who = (req: Request) => ({ orgId: req.tenant!.org.id, userId: req.session!.id });
const fail = (err: unknown, res: Response, next: NextFunction) => {
  if (err instanceof VaultError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  next(err);
};
const gate = [requireAuth, withTenant, vaultDoor];

// UI-SCREEN: /vault
vaultRouter.get("/:slug/vault/folders", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    res.json({ items: await listVaultFolders(orgId, userId) });
  } catch (err) {
    fail(err, res, next);
  }
});

// UI-SCREEN: /vault
// GATE: any member may keep a folder of their own; the folder's access list, not a workspace role, decides who opens it
// AI-REACH: the Vault keeps personal documents out of the assistant's reach; a person makes their own folders (docs/design-decisions/vault.md)
vaultRouter.post("/:slug/vault/folders", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    res.status(201).json(await createVaultFolder(orgId, userId, req.body?.name));
  } catch (err) {
    fail(err, res, next);
  }
});

// UI-SCREEN: /vault
vaultRouter.get("/:slug/vault/folders/:id", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    res.json(await vaultFolder(orgId, userId, String(req.params.id)));
  } catch (err) {
    fail(err, res, next);
  }
});

// UI-SCREEN: /vault
// GATE: the folder's owner, checked in platform/vault.ts; no workspace role reaches another person's folder
// AI-REACH: who may open a Vault folder is its owner's decision alone, made in the Vault, never on the assistant's say-so
vaultRouter.patch("/:slug/vault/folders/:id", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    const id = String(req.params.id);
    if (req.body?.name !== undefined) await renameVaultFolder(orgId, userId, id, req.body.name);
    if (req.body?.people !== undefined) await setVaultFolderPeople(orgId, userId, id, req.body.people);
    res.json(await vaultFolder(orgId, userId, id));
  } catch (err) {
    fail(err, res, next);
  }
});

// UI-SCREEN: /vault
// GATE: the folder's owner, checked in platform/vault.ts
// AI-REACH: deleting a folder of personal documents is its owner's act in the Vault, never the assistant's
vaultRouter.delete("/:slug/vault/folders/:id", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    res.json(await deleteVaultFolder(orgId, userId, String(req.params.id)));
  } catch (err) {
    fail(err, res, next);
  }
});

// UI-SCREEN: /vault
vaultRouter.get("/:slug/vault/folders/:id/history", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    res.json({ items: await vaultFolderHistory(orgId, userId, String(req.params.id)) });
  } catch (err) {
    fail(err, res, next);
  }
});

// UI-SCREEN: /vault
// GATE: anyone on the folder's access list, checked in platform/vault.ts
// AI-REACH: an upload; the assistant files a document it already holds through platform:file-into-vault instead
vaultRouter.post("/:slug/vault/folders/:id/files", ...gate, upload, async (req, res, next) => {
  const file = uploadedFile(req);
  try {
    if (!file) throw new VaultError(400, "file_required", "Choose a file to put in the Vault.");
    const { orgId, userId } = who(req);
    const bytes = await readFile(file.path);
    const kind = typeof req.body?.record_kind === "string" ? req.body.record_kind : "";
    const id = typeof req.body?.record_id === "string" ? req.body.record_id : "";
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name : file.originalname;
    res.status(201).json(await addVaultFile(orgId, userId, String(req.params.id), { name, mimeType: file.mimetype, bytes, record: kind && id ? { kind, id } : null }));
  } catch (err) {
    fail(err, res, next);
  } finally {
    // The plain upload never outlives the request: it is encrypted above or refused.
    if (file) await unlink(file.path).catch(() => undefined);
  }
});

// UI-SCREEN: /vault
vaultRouter.get("/:slug/vault/files/:id/download", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    const inline = req.query.inline === "1";
    const got = await readVaultFile(orgId, userId, String(req.params.id), inline ? "opened" : "downloaded");
    res.setHeader("Content-Type", got.mimeType);
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(got.name)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(got.bytes);
  } catch (err) {
    fail(err, res, next);
  }
});

// UI-SCREEN: /vault
// GATE: anyone on the folder's access list (both folders' for a move), checked in platform/vault.ts
// AI-REACH: renaming, moving or linking a personal document is done in the Vault by someone on both folders' lists, never by the assistant
vaultRouter.patch("/:slug/vault/files/:id", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    res.json(await changeVaultFile(orgId, userId, String(req.params.id), { name: req.body?.name, folder_id: req.body?.folder_id, record: req.body?.record }));
  } catch (err) {
    fail(err, res, next);
  }
});

// UI-SCREEN: /vault
// GATE: the folder's owner or the person who added the file, checked in platform/vault.ts
// AI-REACH: removing a personal document is done in the Vault by its folder's owner or whoever added it, never by the assistant
vaultRouter.delete("/:slug/vault/files/:id", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    await deleteVaultFile(orgId, userId, String(req.params.id));
    res.status(204).end();
  } catch (err) {
    fail(err, res, next);
  }
});

// A record's documents in the Vault, of those the caller may open: a car's
// page lists its registration renewal for the people on that folder's list,
// and for anyone else the list is empty, not a count.
vaultRouter.get("/:slug/vault/record-documents", ...gate, async (req, res, next) => {
  try {
    const { orgId, userId } = who(req);
    const kind = String(req.query.kind ?? "");
    const id = String(req.query.id ?? "");
    if (!kind || !id) throw new VaultError(400, "record_required", "Name the record by kind and id.");
    res.json({ items: await vaultDocumentsFor(orgId, userId, kind, id) });
  } catch (err) {
    fail(err, res, next);
  }
});
