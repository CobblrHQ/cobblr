// /projects — CRUD + a task list endpoint scoped to a project.

import { Router } from "express";
import { z } from "zod";
import { PRIORITIES, PROJECT_STATUSES } from "../vocab.js";
import { platform, textSearchWhere } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata, refuseUnknownFields, withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import {
  latestPatternFileId,
  patternPhotoThumb,
  readPatternPhotoState,
  runPatternPhoto,
  usePatternPhoto,
} from "./pattern-photo.js";
import { listNeeds, readNeedsFromText, readPastedMaterials, readPatternNeedsState, runPatternRead, type PatternNeedsState } from "./pattern-needs.js";
import { matchNeeds, settlePattern, syncShoppingLine, useYarn } from "./pattern-yarn.js";
import { patternTextMatches, snippetsFor } from "./pattern-text.js";

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
    .enum(PROJECT_STATUSES)
    .optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
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
    // `q`: the table's own search box. The same match as every other search
    // (name, notes, custom fields and the pattern's own words), each row that
    // matched inside its words carrying the line it matched on.
    const words = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    let query = db.selectFrom("projects_projects").selectAll().where("instance", "=", instanceOf(req));
    if (words) {
      query = query.where((eb) =>
        eb.or([textSearchWhere(eb, words, { text: ["name", "description", "status"], json: ["metadata"] }), patternTextMatches(words)]),
      );
    }
    const rows = await query.orderBy("created_at", "desc").execute();
    if (!words) {
      res.json({ items: rows });
      return;
    }
    const snippets = await snippetsFor(db, rows, words);
    res.json({ items: rows.map((r) => (snippets.has(r.id) ? { ...r, snippet: snippets.get(r.id) } : r)) });
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
    await refuseUnknownFields(req, req.body, PROJECT_NATIVE_KEYS, "projects:project");
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
    // A pattern made from its text (Ask Cobb saving one, or Save on an answer,
    // both through this route) lists its yarn and hook at once, the way a
    // PDF does when it lands. Never fails the create.
    if (inserted.description) {
      await readNeedsFromText(ctx.org.id, inserted.id, inserted.description).catch((err: unknown) => {
        console.error(`[projects] reading ${inserted.id}'s text for its needs failed:`, (err as Error)?.message ?? err);
      });
    }

    res.status(201).json(inserted);
  }),
);

projectsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    await refuseUnknownFields(req, req.body, PROJECT_NATIVE_KEYS, "projects:project");
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
      .set(withMetadataMerged(patch as Record<string, unknown>) as never)
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
    // Finishing takes each yarn off the stash (its own balls first); giving up
    // lets it all go. Here, on the one route every door writes status through,
    // so a pattern marked done from its page, a table, a board or the
    // assistant is settled the same way (pattern-yarn.ts).
    if (parsed.data.status === "done" || parsed.data.status === "abandoned") {
      await settlePattern(ctx.org.id, session.id, updated.id, parsed.data.status);
    }

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

const ExtractFileBody = z.object({ file_id: z.string().uuid() });

/** Read a pattern file now, asking the AI if its text names nothing. A read
 *  the upload already started (text only) is waited for, then finished. */
async function readPatternNow(orgId: string, projectId: string, fileId: string, userId: string | null) {
  await runPatternRead(orgId, projectId, fileId, { ai: true, userId });
  const again = await readPatternNeedsState(orgId, projectId, userId);
  if (again.read.status === "pending") await runPatternRead(orgId, projectId, fileId, { ai: true, userId });
  return readPatternNeedsState(orgId, projectId, userId);
}

/** The shape the older "suggest from the pattern" door answered in, kept for
 *  API callers: yarn by weight/fibre/colour/length, hooks by gauge. */
function legacyShape(state: PatternNeedsState) {
  const ok = state.read.status === "ready" || state.items.length > 0;
  return {
    ai: ok,
    ...(ok ? {} : { reason: state.read.reason ?? "Couldn't read that pattern." }),
    yarn: state.items
      .filter((n) => n.kind === "yarn")
      .map((n) => ({ fiber: n.fiber, weight: n.weight, color: n.color, length_m: n.length_m, skeins: n.quantity })),
    hooks: state.items.filter((n) => n.kind !== "yarn").map((n) => ({ gauge: n.size_mm != null ? `${n.size_mm} mm` : null })),
    needs: state.items,
    read: state.read,
  };
}

// Read an attached pattern PDF into the pattern's needs, now. The page reads
// by itself (GET /:id/needs); this is the explicit door, and the older name.
// AI-REACH: takes an uploaded pattern file/images; the assistant cannot carry a file
projectsRouter.post(
  "/:id/extract-pattern-file",
  asyncHandler(async (req, res) => {
    const parsed = ExtractFileBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const state = await readPatternNow(ctx.org.id, req.params.id ?? "", parsed.data.file_id, sessionUser(req)?.id ?? null);
    res.json(legacyShape(state));
  }),
);

// What the pattern needs: its yarns, hooks and needles, and how the pattern
// was read. Opening a pattern finishes its reading (pattern-needs.ts).
projectsRouter.get(
  "/:id/needs",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const userId = sessionUser(req)?.id ?? null;
    const projectId = req.params.id ?? "";
    const state = await readPatternNeedsState(ctx.org.id, projectId, userId);
    res.json(await withMatches(ctx.org.id, userId, projectId, state));
  }),
);

/** Each need with what in the stash fits it, what it has used and holds, and
 *  what is short. The stash is read once per page. */
async function withMatches(orgId: string, userId: string | null, projectId: string, state: PatternNeedsState) {
  const matches = await matchNeeds(orgId, userId, projectId, state.items).catch((e: unknown) => {
    console.warn("[projects] pattern match unavailable:", (e as Error).message);
    return new Map();
  });
  return { ...state, items: state.items.map((n) => ({ ...n, match: matches.get(n.id) ?? null })) };
}

const UseBody = z.object({
  part_id: z.string().uuid().nullable(),
  /** On a swap, what the old yarn has given so far, when more than was logged. */
  used_so_far_m: z.number().min(0).optional(),
  used_so_far_units: z.number().min(0).optional(),
});

// Make this yarn requirement with a stash yarn (null lets it go). A second
// pick is a swap: used so far stays on the old yarn's balls, the rest is held
// on the new one, and the shopping line follows.
// AI-REACH: exempt media - picks among the yarns the pattern page shows for one requirement; the assistant reserves through inventory:reserve-stock
projectsRouter.post(
  "/:id/needs/:needId/use",
  asyncHandler(async (req, res) => {
    const parsed = UseBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const userId = sessionUser(req)?.id ?? null;
    const projectId = req.params.id ?? "";
    const r = await useYarn(ctx.org.id, userId, projectId, req.params.needId ?? "", parsed.data.part_id, {
      ...(parsed.data.used_so_far_m != null ? { m: parsed.data.used_so_far_m } : {}),
      ...(parsed.data.used_so_far_units != null ? { units: parsed.data.used_so_far_units } : {}),
    });
    if (!r.ok) {
      res.status(409).json({ error: { code: "cannot_use", message: r.error } });
      return;
    }
    res.json(await withMatches(ctx.org.id, userId, projectId, await readPatternNeedsState(ctx.org.id, projectId, userId)));
  }),
);

// Put what this requirement is missing on the shopping list.
// AI-REACH: exempt media - the assistant adds to a list through lists:add-item
projectsRouter.post(
  "/:id/needs/:needId/shop",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const userId = sessionUser(req)?.id ?? null;
    const projectId = req.params.id ?? "";
    const r = await syncShoppingLine(ctx.org.id, userId, projectId, req.params.needId ?? "", { add: true });
    if (!r.ok) {
      res.status(409).json({ error: { code: "cannot_list", message: r.error } });
      return;
    }
    res.json({ ...r, ...(await withMatches(ctx.org.id, userId, projectId, await readPatternNeedsState(ctx.org.id, projectId, userId))) });
  }),
);

// Read the pattern again: every row nobody edited is replaced.
// AI-REACH: exempt media - re-reads the pattern PDF the person is looking at; the assistant edits needs through the needs routes
projectsRouter.post(
  "/:id/needs/read",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const projectId = req.params.id ?? "";
    const fileId = await latestPatternFileId(ctx.org.id, projectId);
    if (!fileId) {
      res.status(404).json({ error: { code: "no_pattern_file", message: "No pattern PDF is attached to this pattern. Upload one first." } });
      return;
    }
    res.json(await readPatternNow(ctx.org.id, projectId, fileId, sessionUser(req)?.id ?? null));
  }),
);

const NeedFields = z.object({
  kind: z.enum(["yarn", "hook", "needle", "notion"]),
  label: z.string().max(80).nullable().optional(),
  brand: z.string().max(120).nullable().optional(),
  product: z.string().max(120).nullable().optional(),
  color: z.string().max(120).nullable().optional(),
  color_code: z.string().max(40).nullable().optional(),
  weight: z.string().max(40).nullable().optional(),
  fiber: z.string().max(40).nullable().optional(),
  quantity: z.number().positive().nullable().optional(),
  quantity_unit: z.string().max(20).nullable().optional(),
  unit_length_m: z.number().positive().nullable().optional(),
  length_m: z.number().positive().nullable().optional(),
  size_mm: z.number().positive().max(50).nullable().optional(),
  size_label: z.string().max(20).nullable().optional(),
});
const NeedCreate = NeedFields;
/** An edit; `length_choice` picks one of the per-ball lengths the pattern gave
 *  ("solid" / "print"), which sets the per-ball and total length together. */
const NeedUpdate = NeedFields.partial().extend({ length_choice: z.string().max(40).optional() });

async function ensureProject(req: Parameters<typeof tenantDb>[0], id: string) {
  return tenantDb(req)
    .selectFrom("projects_projects")
    .select(["id"])
    .where("id", "=", id)
    .where("instance", "=", instanceOf(req))
    .executeTakeFirst();
}

// AI-REACH: exempt hand edits to a pattern's needs list on its page; the assistant reads the list through GET /needs
projectsRouter.post(
  "/:id/needs",
  asyncHandler(async (req, res) => {
    const parsed = NeedCreate.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const projectId = req.params.id ?? "";
    if (!(await ensureProject(req, projectId))) {
      res.status(404).json({ error: { code: "not_found", message: "pattern not found" } });
      return;
    }
    const db = tenantDb(req);
    const last = await db
      .selectFrom("projects_pattern_needs")
      .select((eb) => eb.fn.max("position").as("p"))
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    const d = parsed.data;
    const length = d.length_m ?? (d.quantity != null && d.unit_length_m != null ? Math.round(d.quantity * d.unit_length_m) : null);
    const row = await db
      .insertInto("projects_pattern_needs")
      .values({ ...d, length_m: length, project_id: projectId, position: Number(last?.p ?? -1) + 1, source: "hand", edited: true } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    const items = await listNeeds(db, projectId);
    res.status(201).json(items.find((n) => n.id === row.id));
  }),
);

// AI-REACH: exempt hand edits to a pattern's needs list on its page; the assistant reads the list through GET /needs
projectsRouter.patch(
  "/:id/needs/:needId",
  asyncHandler(async (req, res) => {
    const parsed = NeedUpdate.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const projectId = req.params.id ?? "";
    const db = tenantDb(req);
    const cur = (await listNeeds(db, projectId)).find((n) => n.id === req.params.needId);
    if (!cur) {
      res.status(404).json({ error: { code: "not_found", message: "no such need on this pattern" } });
      return;
    }
    const { length_choice, ...fields } = parsed.data;
    const patch: Record<string, unknown> = { ...fields, edited: true, updated_at: new Date() };
    if (length_choice !== undefined) {
      const pick = (cur.length_choices ?? []).find((c) => c.label === length_choice);
      if (!pick) {
        res.status(400).json({ error: { code: "bad_choice", message: `The pattern gives no "${length_choice}" length.` } });
        return;
      }
      patch.unit_length_m = pick.unit_length_m;
    }
    const quantity = "quantity" in fields ? fields.quantity : cur.quantity;
    const unit = (patch.unit_length_m as number | null | undefined) ?? ("unit_length_m" in fields ? fields.unit_length_m : cur.unit_length_m);
    if (!("length_m" in fields) && ("quantity" in fields || "unit_length_m" in patch)) {
      patch.length_m = quantity != null && unit != null ? Math.round(quantity * unit) : cur.length_m;
    }
    await db.updateTable("projects_pattern_needs").set(patch as never).where("id", "=", cur.id).execute();
    if (cur.list_item_id) await syncShoppingLine(tenantContext(req).org.id, sessionUser(req)?.id ?? null, projectId, cur.id);
    res.json((await listNeeds(db, projectId)).find((n) => n.id === cur.id));
  }),
);

// AI-REACH: exempt hand edits to a pattern's needs list on its page; the assistant reads the list through GET /needs
projectsRouter.delete(
  "/:id/needs/:needId",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const projectId = req.params.id ?? "";
    const cur = (await listNeeds(db, projectId)).find((n) => n.id === req.params.needId);
    // Its balls go back to the pool and its shopping line comes off, first.
    if (cur && !cur.settled_at && (cur.part_id || cur.list_item_id)) {
      const orgId = tenantContext(req).org.id;
      const userId = sessionUser(req)?.id ?? null;
      if (cur.part_id) await useYarn(orgId, userId, projectId, cur.id, null);
      await syncShoppingLine(orgId, userId, projectId, cur.id, { withdraw: true }).catch(() => undefined);
    }
    const gone = await db
      .deleteFrom("projects_pattern_needs")
      .where("id", "=", req.params.needId ?? "")
      .where("project_id", "=", req.params.id ?? "")
      .returning("id")
      .executeTakeFirst();
    if (!gone) {
      res.status(404).json({ error: { code: "not_found", message: "no such need on this pattern" } });
      return;
    }
    res.status(204).end();
  }),
);

// The "pull the photo out of the pattern" door, kept for the API and the
// assistant. The pull itself runs by itself when a pattern is attached (see
// pattern-photo.ts); this route is the explicit re-run. Body takes an optional
// `file_id` (a specific PDF); otherwise the design's most recent pattern PDF.
const ExtractImagesBody = z.object({ file_id: z.string().uuid().optional() });

// AI-REACH: takes an uploaded pattern file/images; the assistant cannot carry a file
projectsRouter.post(
  "/:id/extract-pattern-images",
  asyncHandler(async (req, res) => {
    const parsed = ExtractImagesBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const designId = req.params.id ?? "";

    const fileId = parsed.data.file_id ?? (await latestPatternFileId(ctx.org.id, designId));
    if (!fileId) {
      res.status(404).json({
        error: {
          code: "no_pattern_file",
          message: "No pattern PDF is attached to this design. Upload one first.",
        },
      });
      return;
    }

    // A fresh read every time this door is used: it is the explicit "pull
    // again" (and the AI's), so a recorded below-floor answer does not stick.
    const state = await runPatternPhoto(ctx.org.id, designId, fileId, { force: true });
    if (state.error) {
      res.json({ ok: false, reason: `Couldn't read images from that PDF (${state.error}).`, images: [] });
      return;
    }
    if (state.extracted === 0) {
      res.json({ ok: false, reason: "No usable photos were embedded in that PDF.", images: [] });
      return;
    }
    if (state.photo_file_id === null) {
      res.json({
        ok: false,
        reason:
          state.hero_index === null
            ? `None of the ${state.extracted} images in that PDF looks like a photograph. Open the strip to choose one by hand.`
            : "The design already has a photo; open the strip to swap it.",
        images: [],
        candidates: state.extracted,
      });
      return;
    }
    const used = state.candidates.find((c) => c.index === state.used_index);
    res.status(201).json({
      ok: true,
      file: {
        id: state.photo_file_id,
        width: used?.width ?? 0,
        height: used?.height ?? 0,
        bytes: 0,
        mime_type: "image/png",
      },
      attachment_id: null,
      candidates: state.extracted,
    });
  }),
);

// What the pattern & photos panel renders: the pull's result and the strip
// of alternatives. A design with a pattern and no recorded pull starts one.
projectsRouter.get(
  "/:id/pattern-photo",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    res.json(await readPatternPhotoState(ctx.org.id, req.params.id ?? ""));
  }),
);

projectsRouter.get(
  "/:id/pattern-photo/candidates/:idx/thumb",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0) {
      res.status(400).json({ error: { code: "bad_index", message: "idx must be a non-negative integer" } });
      return;
    }
    const jpeg = await patternPhotoThumb(ctx.org.id, req.params.id ?? "", idx);
    if (!jpeg) {
      res.status(404).json({ error: { code: "not_found", message: "no such candidate" } });
      return;
    }
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("cache-control", "private, max-age=3600");
    res.send(jpeg);
  }),
);

const UsePatternPhotoBody = z.object({ index: z.number().int().min(0) });

// AI-REACH: exempt media - picks among image tiles the user is looking at; the assistant cannot see the strip
projectsRouter.post(
  "/:id/pattern-photo/use",
  asyncHandler(async (req, res) => {
    const parsed = UsePatternPhotoBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const r = await usePatternPhoto(ctx.org.id, req.params.id ?? "", parsed.data.index);
    res.status(r.ok ? 201 : 200).json(r);
  }),
);

// Pasted materials text: read into the pattern's needs, its own words first.
// AI-REACH: takes an uploaded pattern file/images; the assistant cannot carry a file
projectsRouter.post(
  "/:id/extract-pattern",
  asyncHandler(async (req, res) => {
    const parsed = ExtractBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const projectId = req.params.id ?? "";
    const r = await readPastedMaterials(ctx.org.id, projectId, parsed.data.text, sessionUser(req)?.id ?? null);
    const state = await readPatternNeedsState(ctx.org.id, projectId, sessionUser(req)?.id ?? null);
    if ("error" in r) {
      res.json({ ai: false, reason: r.error, yarn: [], hooks: [], needs: state.items, read: state.read });
      return;
    }
    res.json(legacyShape({ ...state, read: { ...state.read, status: "ready", method: r.method } }));
  }),
);
