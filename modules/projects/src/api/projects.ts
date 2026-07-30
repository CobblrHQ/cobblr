// /projects — CRUD + a task list endpoint scoped to a project.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata } from "./route-helpers.js";
import { extractPdfImages } from "./pdf-images.js";

export const projectsRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every mutating request on this
// router (covers both the direct mount and the instance-items dispatch
// path). Finer per-action roles can layer on top. (Audit 2026-06-26 P0 #1.)
projectsRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

const ProjectCreate = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(8_000).nullable().optional(),
  status: z
    .enum(["planning", "active", "blocked", "done", "abandoned"])
    .optional(),
  priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
  start_date: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  completion_date: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PROJECT_NATIVE_KEYS = new Set(Object.keys(ProjectCreate.shape));
const ProjectUpdate = ProjectCreate.partial();

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("projects_projects")
      .selectAll()
      .where("instance", "=", instanceOf(req))
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows });
  }),
);

projectsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("projects_projects")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.json(row);
  }),
);

projectsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, PROJECT_NATIVE_KEYS);
    const parsed = ProjectCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const inserted = await db
      .insertInto("projects_projects")
      .values({
        instance: instanceOf(req),
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? "active",
        priority: parsed.data.priority ?? "med",
        start_date: parsed.data.start_date ? new Date(parsed.data.start_date) : null,
        target_date: parsed.data.target_date ? new Date(parsed.data.target_date) : null,
        completion_date: parsed.data.completion_date ? new Date(parsed.data.completion_date) : null,
        color: parsed.data.color ?? null,
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "project_created",
      ref: { module: "projects", entityType: "project", entityId: inserted.id },
      diff: { name: inserted.name },
    });
    platform().events.emit("projects.project.created", {
      orgId: ctx.org.id,
      projectId: inserted.id,
    });

    res.status(201).json(inserted);
  }),
);

projectsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, PROJECT_NATIVE_KEYS);
    const parsed = ProjectUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (
        (k === "start_date" || k === "target_date" || k === "completion_date") &&
        v != null &&
        typeof v === "string"
      ) {
        patch[k] = new Date(v);
      } else {
        patch[k] = v;
      }
    }

    const updated = await db
      .updateTable("projects_projects")
      .set(patch)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "project not found" } });
      return;
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "project_updated",
      ref: { module: "projects", entityType: "project", entityId: updated.id },
      diff: parsed.data,
    });
    platform().events.emit("projects.project.updated", {
      orgId: ctx.org.id,
      projectId: updated.id,
    });

    res.json(updated);
  }),
);

projectsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const deleted = await db
      .deleteFrom("projects_projects")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.status(204).end();
  }),
);

// ── AI: extract materials from a pattern (Phase 3) ─────────────────────
// Reads pasted pattern text and returns the yarn + hooks it calls for, via
// core-ai (capability: chat). Degrades to { ai: false } when no provider is
// configured, so the UI can prompt the user instead of erroring.
const ExtractBody = z.object({ text: z.string().min(1).max(20_000) });

/** The materials-extraction prompt + call, shared by the paste-text and
 *  attached-PDF paths. Returns the {ai, yarn, hooks} shape both render. */
async function extractMaterials(orgId: string, designId: string, text: string, userId?: string | null) {
  const system =
    "You read a crochet/knitting pattern and extract ONLY the materials it " +
    "calls for. Reply with ONLY a JSON object, no prose:\n" +
    '{"yarn":[{"fiber":<string|null>,"weight":<string|null, e.g. "Worsted",' +
    '"DK","Aran">,"color":<string|null>,"length_m":<number|null total metres>,' +
    '"skeins":<number|null>}],"hooks":[{"gauge":<string, e.g. "4.0 mm">}]}\n' +
    "Use null when the pattern doesn't state something. If it lists no yarn or " +
    "no hooks, use an empty array. Convert yards to metres (×0.9144).";
  const r = await platform().ai.invoke({
    orgId,
    userId: userId ?? undefined,
    capability: "chat",
    input: {
      messages: [
        { role: "system", content: system },
        { role: "user", content: text.slice(0, 20_000) },
      ],
    },
    source: { kind: "projects:pattern-extract", id: designId },
  });
  const content = (r.result as { content?: string })?.content ?? "";
  const m = content.match(/\{[\s\S]*\}/);
  const obj = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
  if (!obj) return null;
  return {
    ai: true as const,
    yarn: Array.isArray(obj.yarn) ? obj.yarn : [],
    hooks: Array.isArray(obj.hooks) ? obj.hooks : [],
  };
}

const ExtractFileBody = z.object({ file_id: z.string().uuid() });

// The "store the pattern, let the AI read it" path: a pattern PDF attached
// to the design (core-files) → text via pdf-parse → the same materials
// extraction as paste-text. The webapp matches the result against stock
// (hooks by gauge, yarn by weight/fiber) — the design becomes the bridge
// between the pattern and the yarn/hooks actually on the shelf.
projectsRouter.post(
  "/:id/extract-pattern-file",
  asyncHandler(async (req, res) => {
    const parsed = ExtractFileBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const bytes = await platform().files.read(ctx.org.id, parsed.data.file_id, "original");
    if (!bytes) {
      res.status(404).json({ error: { code: "file_not_found", message: "pattern file not found" } });
      return;
    }
    let text = "";
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(bytes.bytes) });
      text = (await parser.getText()).text ?? "";
    } catch {
      res.json({ ai: false, reason: "Couldn't read that PDF.", yarn: [], hooks: [] });
      return;
    }
    if (!text.trim()) {
      res.json({ ai: false, reason: "That PDF has no extractable text (a scan?).", yarn: [], hooks: [] });
      return;
    }
    try {
      const out = await extractMaterials(ctx.org.id, req.params.id ?? "", text, sessionUser(req)?.id ?? null);
      if (!out) {
        res.json({ ai: false, reason: "Couldn't read that pattern.", yarn: [], hooks: [] });
        return;
      }
      res.json(out);
    } catch (e) {
      res.json({
        ai: false,
        reason:
          e instanceof Error && /provider|capability|budget/i.test(e.message)
            ? "No AI provider is set up for this workspace yet (Configuration → AI)."
            : "AI is unavailable right now.",
        yarn: [],
        hooks: [],
      });
    }
  }),
);

// The "pull the photo out of the pattern" path. A pattern PDF carries the
// finished-object photo embedded on page one; rather than make the user upload
// a separate image, we read the images straight out of the stored PDF, pick
// the largest real photo, save it as a core-file, and attach it to this design
// as role=photo — the same attachment shape the UI's upload path writes. Body
// takes an optional `file_id` (a specific PDF); otherwise we use the design's
// most-recently-attached pattern PDF.
//
// core-files is a different module, so we don't touch its tables directly:
// reads/writes of bytes go through the platform().files seam, and the
// attachment lookup/create go through core-files' own HTTP endpoints carrying
// the caller's bearer (same loopback-self-call pattern core-scan uses to
// attach catalog photos — runs through requireAuth + withTenant like a real
// upload). Keeps the module boundary honest.
const ExtractImagesBody = z.object({ file_id: z.string().uuid().optional() });

// Loopback base for the self-call. `x-cobblr-base-url` override stays for
// isolated-stack e2e (matches core-scan).
const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

function bearerToken(req: import("express").Request): string | null {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

projectsRouter.post(
  "/:id/extract-pattern-images",
  asyncHandler(async (req, res) => {
    const parsed = ExtractImagesBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const designId = req.params.id ?? "";

    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "missing bearer" } });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const filesBase = `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/core-files`;
    const authHeader = { authorization: `Bearer ${token}` };

    // Resolve the source PDF: the one named, else the design's latest pattern.
    // The attachments list endpoint doesn't filter by role, so we filter here.
    let fileId = parsed.data.file_id ?? null;
    if (!fileId) {
      const q = `${filesBase}/attachments?source_module=projects&source_type=project&source_id=${encodeURIComponent(designId)}`;
      const r = await fetch(q, { headers: authHeader });
      if (r.ok) {
        const body = (await r.json()) as {
          items?: Array<{ file_id: string; role: string | null; sort_order?: number }>;
        };
        const pattern = (body.items ?? [])
          .filter((a) => a.role === "pattern")
          .sort((a, b) => (b.sort_order ?? 0) - (a.sort_order ?? 0))[0];
        fileId = pattern?.file_id ?? null;
      }
    }
    if (!fileId) {
      res.status(404).json({
        error: {
          code: "no_pattern_file",
          message: "No pattern PDF is attached to this design. Upload one first.",
        },
      });
      return;
    }

    const bytes = await platform().files.read(ctx.org.id, fileId, "original");
    if (!bytes) {
      res.status(404).json({ error: { code: "file_not_found", message: "pattern file not found" } });
      return;
    }

    let images;
    try {
      images = await extractPdfImages(bytes.bytes);
    } catch {
      res.json({ ok: false, reason: "Couldn't read images from that PDF.", images: [] });
      return;
    }
    if (images.length === 0) {
      res.json({ ok: false, reason: "No usable photos were embedded in that PDF.", images: [] });
      return;
    }

    // Save the hero (largest) image and attach it as this design's photo.
    const hero = images[0]!;
    const baseName = (bytes.filename || "pattern").replace(/\.pdf$/i, "");
    const written = await platform().files.write(ctx.org.id, hero.png, {
      filename: `${baseName}-photo.png`,
      mimeType: "image/png",
    });
    if (!written) {
      res.status(500).json({ error: { code: "write_failed", message: "couldn't save the image" } });
      return;
    }

    // Attach role=photo via core-files' own endpoint (mirrors the UI upload
    // path). A repeat pull writes a fresh file, so multiple photos are fine —
    // core-files assigns sort_order.
    const ar = await fetch(`${filesBase}/attachments`, {
      method: "POST",
      headers: { ...authHeader, "content-type": "application/json" },
      body: JSON.stringify({
        file_id: written.fileId,
        source_module: "projects",
        source_type: "project",
        source_id: designId,
        role: "photo",
      }),
    });
    if (!ar.ok) {
      res.status(502).json({ error: { code: "attach_failed", message: `attach ${ar.status}` } });
      return;
    }
    const attachment = (await ar.json()) as { id?: string };

    res.status(201).json({
      ok: true,
      file: {
        id: written.fileId,
        width: hero.width,
        height: hero.height,
        bytes: hero.bytes,
        mime_type: written.mimeType,
      },
      attachment_id: attachment.id ?? null,
      candidates: images.length,
    });
  }),
);

projectsRouter.post(
  "/:id/extract-pattern",
  asyncHandler(async (req, res) => {
    const parsed = ExtractBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const system =
      "You read a crochet/knitting pattern and extract ONLY the materials it " +
      "calls for. Reply with ONLY a JSON object, no prose:\n" +
      '{"yarn":[{"fiber":<string|null>,"weight":<string|null, e.g. "Worsted",' +
      '"DK","Aran">,"color":<string|null>,"length_m":<number|null total metres>,' +
      '"skeins":<number|null>}],"hooks":[{"gauge":<string, e.g. "4.0 mm">}]}\n' +
      "Use null when the pattern doesn't state something. If it lists no yarn or " +
      "no hooks, use an empty array. Convert yards to metres (×0.9144).";
    try {
      const r = await platform().ai.invoke({
        orgId: ctx.org.id,
        userId: sessionUser(req)?.id ?? null,
        capability: "chat",
        input: {
          messages: [
            { role: "system", content: system },
            { role: "user", content: parsed.data.text.slice(0, 20_000) },
          ],
        },
        source: { kind: "projects:pattern-extract", id: req.params.id ?? "" },
      });
      const content = (r.result as { content?: string })?.content ?? "";
      const m = content.match(/\{[\s\S]*\}/);
      const obj = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
      if (!obj) {
        res.json({ ai: false, reason: "Couldn't read that pattern. Try pasting more of it.", yarn: [], hooks: [] });
        return;
      }
      res.json({
        ai: true,
        yarn: Array.isArray(obj.yarn) ? obj.yarn : [],
        hooks: Array.isArray(obj.hooks) ? obj.hooks : [],
      });
    } catch (e) {
      // No provider / over budget / provider error → graceful degrade.
      res.json({
        ai: false,
        reason:
          e instanceof Error && /provider|capability|budget/i.test(e.message)
            ? "No AI provider is set up for this workspace yet (Configuration → AI)."
            : "AI is unavailable right now.",
        yarn: [],
        hooks: [],
      });
    }
  }),
);
