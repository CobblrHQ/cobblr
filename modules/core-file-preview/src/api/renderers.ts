// /renderers — install / list / uninstall third-party preview renderers.
//
// A renderer is a JS bundle that runs ONLY in the client sandbox
// (SandboxedRenderer: opaque-origin iframe, no network, no API token), so
// the server-side safety boundary is the sandbox, not this endpoint. What
// this endpoint adds is supply-chain INTEGRITY: if the registry entry was
// signed, we verify the ed25519 signature over the exact bundle bytes
// before storing — a tampered bundle is rejected. The trust *tier*
// (official / unverified) is computed at browse time from the registry's
// vouched keys; the consent gate (web) handles unverified installs.
// See docs/modules/extension-registry.md §2.4.

import { Router } from "express";
import { z } from "zod";
import { verify as cryptoVerify, createPublicKey } from "node:crypto";
import { tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const renderersRouter = Router({ mergeParams: true });

function verifyEd25519(pubkeyB64: string, dataUtf8: string, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
    const sig = Buffer.from(sigB64.startsWith("ed25519:") ? sigB64.slice(8) : sigB64, "base64");
    return cryptoVerify(null, Buffer.from(dataUtf8, "utf8"), key, sig);
  } catch {
    return false;
  }
}

const InstallBody = z.object({
  name: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  version: z.string().max(32).optional(),
  exts: z.array(z.string().regex(/^[a-z0-9]+$/).max(12)).min(1).max(20),
  /** The renderer JS bundle (capped — it ships inline in the index). */
  renderer_js: z.string().min(1).max(2_000_000),
  pubkey: z.string().max(1000).optional(),
  signature: z.string().max(1000).optional(),
});

const COLS = ["id", "name", "version", "exts", "renderer_js", "signed_by", "created_at"] as const;

// GET — the workspace's installed renderers, JS included (the web needs it
// to register the sandboxed loaders).
renderersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req)
      .selectFrom("core_file_preview_renderers")
      .select([...COLS])
      .orderBy("name")
      .execute();
    res.json({ items: rows });
  }),
);

// POST — install (admin). Upserts on name. Verifies the signature if the
// bundle is signed; a signed-but-bad bundle is rejected.
// AI-REACH: authoring of a user-built surface; a whole-workspace build goes through the design flow, and records inside an app are reachable as records
renderersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = InstallBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const m = parsed.data;
    if (m.pubkey && m.signature && !verifyEd25519(m.pubkey, m.renderer_js, m.signature)) {
      res.status(400).json({ error: { code: "bad_signature", message: "renderer signature did not verify" } });
      return;
    }
    const row = await tenantDb(req)
      .insertInto("core_file_preview_renderers")
      .values({
        name: m.name,
        version: m.version ?? null,
        exts: m.exts,
        renderer_js: m.renderer_js,
        signed_by: m.pubkey ?? null,
      })
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({
          version: m.version ?? null,
          exts: m.exts,
          renderer_js: m.renderer_js,
          signed_by: m.pubkey ?? null,
          updated_at: new Date(),
        }),
      )
      .returning(["id", "name", "version", "exts", "signed_by"])
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// DELETE — uninstall (admin).
// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
renderersRouter.delete(
  "/:name",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await tenantDb(req)
      .deleteFrom("core_file_preview_renderers")
      .where("name", "=", req.params.name!)
      .execute();
    res.status(204).end();
  }),
);
