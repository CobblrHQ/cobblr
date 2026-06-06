// core-print router. Mounted at /api/v1/orgs/:slug/modules/core-print/.
//
//   GET    /printers              list configured printers (no secrets)
//   POST   /printers              add one (owner/admin)
//   GET    /printers/:id          one
//   PATCH  /printers/:id          edit (owner/admin)
//   DELETE /printers/:id          remove (owner/admin)
//   POST   /printers/:id/test     reachability check
//   POST   /printers/:id/print    submit a document → { jobId, state }
//
// A document is either a core-files `file_id` (already uploaded) or inline
// `document_base64` (a label rendered on the fly). The client value never
// carries secrets back; credentials are stored encrypted per-org.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { assertSafePrinterUrl } from "../drivers/ssrf.js";
import { buildDriver, isDriverKind } from "../drivers/registry.js";
import type { PrinterConfig, PrintDoc } from "../drivers/types.js";
import type { CorePrintPrintersTable } from "../db.js";
import type { Selectable } from "kysely";

const router = Router({ mergeParams: true });

type PrinterRow = Selectable<CorePrintPrintersTable>;

function serialize(row: PrinterRow) {
  return {
    id: row.id,
    name: row.name,
    driver: row.driver,
    base_url: row.base_url,
    queue: row.queue,
    is_default: row.is_default,
    notes: row.notes,
    has_credentials: !!row.credentials_enc,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const Credentials = z
  .object({
    username: z.string().max(200).optional(),
    password: z.string().max(500).optional(),
    apiKey: z.string().max(500).optional(),
  })
  .strict();

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  driver: z.string().max(40).default("cups"),
  base_url: z.string().min(1).max(500),
  queue: z.string().min(1).max(200),
  credentials: Credentials.optional(),
  is_default: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

const PatchBody = CreateBody.partial();

const PrintBody = z
  .object({
    file_id: z.string().uuid().optional(),
    document_base64: z.string().optional(),
    content_type: z.string().max(200).optional(),
    filename: z.string().max(300).optional(),
    copies: z.number().int().min(1).max(100).optional(),
    job_name: z.string().max(300).optional(),
  })
  .refine((b) => !!b.file_id || !!b.document_base64, {
    message: "provide a file_id or document_base64",
  });

async function configuredDriver(orgId: string, row: PrinterRow) {
  let creds: Record<string, unknown> = {};
  if (row.credentials_enc) {
    creds = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
  }
  const cfg: PrinterConfig = {
    baseUrl: row.base_url,
    queue: row.queue,
    username: typeof creds.username === "string" ? creds.username : undefined,
    password: typeof creds.password === "string" ? creds.password : undefined,
    apiKey: typeof creds.apiKey === "string" ? creds.apiKey : undefined,
  };
  return buildDriver(row.driver, cfg);
}

// ─────────────────────────────── CRUD ──────────────────────────────

router.get(
  "/printers",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db.selectFrom("core_print_printers").selectAll().orderBy("created_at", "asc").execute();
    res.json({ items: rows.map(serialize) });
  }),
);

router.get(
  "/printers/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const row = await db.selectFrom("core_print_printers").selectAll().where("id", "=", req.params.id as string).executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "no such printer" } });
      return;
    }
    res.json(serialize(row));
  }),
);

router.post(
  "/printers",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;
    if (!isDriverKind(body.driver)) {
      res.status(400).json({ error: { code: "bad_driver", message: `unknown driver '${body.driver}'` } });
      return;
    }
    if (body.driver === "cups") {
      try {
        assertSafePrinterUrl(body.base_url);
      } catch (e) {
        res.status(400).json({ error: { code: "bad_url", message: (e as Error).message } });
        return;
      }
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const credentials_enc = body.credentials
      ? await platform().integrations.encryptCredentials(ctx.org.id, body.credentials)
      : null;

    if (body.is_default) {
      await db.updateTable("core_print_printers").set({ is_default: false }).where("is_default", "=", true).execute();
    }
    const row = await db
      .insertInto("core_print_printers")
      .values({
        name: body.name,
        driver: body.driver,
        base_url: body.base_url,
        queue: body.queue,
        credentials_enc,
        is_default: body.is_default ?? false,
        notes: body.notes ?? null,
        created_by_user_id: session.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(serialize(row));
  }),
);

router.patch(
  "/printers/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.driver !== undefined) {
      if (!isDriverKind(body.driver)) {
        res.status(400).json({ error: { code: "bad_driver", message: `unknown driver '${body.driver}'` } });
        return;
      }
      patch.driver = body.driver;
    }
    if (body.base_url !== undefined) {
      try {
        assertSafePrinterUrl(body.base_url);
      } catch (e) {
        res.status(400).json({ error: { code: "bad_url", message: (e as Error).message } });
        return;
      }
      patch.base_url = body.base_url;
    }
    if (body.queue !== undefined) patch.queue = body.queue;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.credentials !== undefined) {
      patch.credentials_enc = await platform().integrations.encryptCredentials(ctx.org.id, body.credentials);
    }
    if (body.is_default === true) {
      await db.updateTable("core_print_printers").set({ is_default: false }).where("is_default", "=", true).execute();
      patch.is_default = true;
    } else if (body.is_default === false) {
      patch.is_default = false;
    }

    const row = await db
      .updateTable("core_print_printers")
      .set(patch)
      .where("id", "=", req.params.id as string)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "no such printer" } });
      return;
    }
    res.json(serialize(row));
  }),
);

router.delete(
  "/printers/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const r = await db.deleteFrom("core_print_printers").where("id", "=", req.params.id as string).executeTakeFirst();
    if (!r.numDeletedRows) {
      res.status(404).json({ error: { code: "not_found", message: "no such printer" } });
      return;
    }
    res.status(204).end();
  }),
);

// ───────────────────────────── test + print ─────────────────────────

router.post(
  "/printers/:id/test",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db.selectFrom("core_print_printers").selectAll().where("id", "=", req.params.id as string).executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "no such printer" } });
      return;
    }
    const driver = await configuredDriver(ctx.org.id, row);
    res.json(await driver.test());
  }),
);

router.post(
  "/printers/:id/print",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PrintBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const body = parsed.data;
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    const row = await db.selectFrom("core_print_printers").selectAll().where("id", "=", req.params.id as string).executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "no such printer" } });
      return;
    }

    // Resolve the document bytes.
    let doc: PrintDoc;
    if (body.file_id) {
      const f = await platform().files.read(ctx.org.id, body.file_id);
      if (!f) {
        res.status(404).json({ error: { code: "file_not_found", message: "no such file" } });
        return;
      }
      doc = {
        bytes: f.bytes,
        filename: body.filename ?? f.filename,
        contentType: body.content_type ?? f.mimeType,
      };
    } else {
      doc = {
        bytes: new Uint8Array(Buffer.from(body.document_base64!, "base64")),
        filename: body.filename ?? "document",
        contentType: body.content_type ?? "application/octet-stream",
      };
    }

    const driver = await configuredDriver(ctx.org.id, row);
    try {
      const result = await driver.print(doc, { copies: body.copies, jobName: body.job_name });
      void platform().events.emit("core-print.job.submitted", {
        orgId: ctx.org.id,
        printerId: row.id,
        jobId: result.jobId,
        state: result.state,
      });
      res.status(202).json({ printer_id: row.id, ...result });
    } catch (e) {
      void platform().events.emit("core-print.job.failed", {
        orgId: ctx.org.id,
        printerId: row.id,
        error: (e as Error).message,
      });
      res.status(502).json({ error: { code: "print_failed", message: (e as Error).message } });
    }
  }),
);

export default router;
