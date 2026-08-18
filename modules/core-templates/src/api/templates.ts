// /api/v1/orgs/:slug/modules/core-templates/templates
//
// CRUD + the killer `/:id/instantiate` endpoint that POSTs the
// template's defaults (merged with caller overrides) to the target
// kind's create endpoint, then attaches default_tags polymorphically.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { bearer, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const templatesRouter = Router({ mergeParams: true });

const TemplateCreate = z.object({
  target_kind: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  description: z.string().max(2_000).nullable().optional(),
  defaults: z.record(z.unknown()).optional(),
  default_tags: z.array(z.string().min(1)).max(50).optional(),
  position: z.number().int().optional(),
});

const TemplateUpdate = TemplateCreate.partial();

const Instantiate = z.object({
  /** Caller's overrides — merged on top of defaults at instantiate
   *  time. The shape is exactly what the target kind's create
   *  endpoint accepts; the merged body is sent verbatim. */
  overrides: z.record(z.unknown()).optional(),
});

// Map (entity_kind) → (module, create endpoint path). Templates need
// to know where to POST when instantiating. Built from the set of
// kinds Cobblr's first-party modules currently expose; new kinds
// can be added here without schema changes.
const KIND_CREATE_ENDPOINTS: Record<string, string> = {
  "inventory:part": "inventory/parts",
  "machines:machine": "machines/machines",
  "assets:asset": "assets/assets",
  "projects:project": "projects/projects",
  "projects:task": "projects/tasks",
  "purchases:order": "purchases/orders",
  "core-locations:location": "core-locations/locations",
};

templatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const kindFilter = typeof req.query.target_kind === "string" ? req.query.target_kind : null;
    let q = db.selectFrom("core_templates_templates").selectAll();
    if (kindFilter) q = q.where("target_kind", "=", kindFilter);
    const items = await q.orderBy("target_kind").orderBy("position").orderBy("name").execute();
    res.json({ items });
  }),
);

templatesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_templates_templates")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "template not found" } });
      return;
    }
    res.json(row);
  }),
);

// AI-REACH: authoring of a user-built surface; a whole-workspace build goes through the design flow, and records inside an app are reachable as records
templatesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = TemplateCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const row = await db
      .insertInto("core_templates_templates")
      .values({
        target_kind: parsed.data.target_kind,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        defaults: sql`${JSON.stringify(parsed.data.defaults ?? {})}::jsonb` as never,
        default_tags: sql`${JSON.stringify(parsed.data.default_tags ?? [])}::jsonb` as never,
        position: parsed.data.position ?? 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    void platform().events.emit("core-templates.template.created", {
      orgId: ctx.org.id,
      templateId: row.id,
      targetKind: row.target_kind,
    });
    res.status(201).json(row);
  }),
);

// AI-REACH: authoring of a user-built surface; a whole-workspace build goes through the design flow, and records inside an app are reachable as records
templatesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = TemplateUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.target_kind !== undefined) patch.target_kind = parsed.data.target_kind;
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.defaults !== undefined) {
      patch.defaults = sql`${JSON.stringify(parsed.data.defaults)}::jsonb` as never;
    }
    if (parsed.data.default_tags !== undefined) {
      patch.default_tags = sql`${JSON.stringify(parsed.data.default_tags)}::jsonb` as never;
    }
    if (parsed.data.position !== undefined) patch.position = parsed.data.position;
    const row = await db
      .updateTable("core_templates_templates")
      .set(patch as never)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "template not found" } });
      return;
    }
    void platform().events.emit("core-templates.template.updated", {
      orgId: ctx.org.id,
      templateId: row.id,
    });
    res.json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
templatesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const row = await db
      .deleteFrom("core_templates_templates")
      .where("id", "=", id)
      .returning(["id"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "template not found" } });
      return;
    }
    void platform().events.emit("core-templates.template.deleted", {
      orgId: ctx.org.id,
      templateId: id,
    });
    res.status(204).end();
  }),
);

// The interesting one. POSTs to the target kind's create endpoint
// with (defaults ∪ overrides), then attaches default_tags via
// core-tags' polymorphic attachments table. Returns the created
// entity verbatim.
// AI-REACH: authoring of a user-built surface; a whole-workspace build goes through the design flow, and records inside an app are reachable as records
templatesRouter.post(
  "/:id/instantiate",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Instantiate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const db = tenantDb(req);
    const tmpl = await db
      .selectFrom("core_templates_templates")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!tmpl) {
      res.status(404).json({ error: { code: "not_found", message: "template not found" } });
      return;
    }
    const createPath = KIND_CREATE_ENDPOINTS[tmpl.target_kind];
    if (!createPath) {
      res.status(400).json({
        error: {
          code: "unknown_target_kind",
          message: `No create endpoint registered for ${tmpl.target_kind}. Add to KIND_CREATE_ENDPOINTS.`,
        },
      });
      return;
    }

    // Merge order: defaults first, overrides win. Shallow merge —
    // nested objects (e.g. metadata) get replaced, not deep-merged.
    // Callers that want to merge metadata themselves can do so on
    // the client side before sending the overrides body.
    const body = {
      ...(tmpl.defaults as Record<string, unknown>),
      ...((parsed.data.overrides ?? {}) as Record<string, unknown>),
    };

    // Re-issue through the api against the SAME bearer token so the
    // call goes through requireAuth + withTenant + role gating
    // already on the target endpoint. URL is workspace-scoped and
    // points at this same host.
    const baseUrl =
      (req.headers["x-cobblr-base-url"] as string | undefined) ??
      `${req.protocol}://${req.headers.host ?? "localhost"}`;
    const createUrl = `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${createPath}`;

    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      res.status(createRes.status).json({
        error: {
          code: "create_failed",
          message: `Target create endpoint returned ${createRes.status}`,
          details: errText,
        },
      });
      return;
    }
    const created = (await createRes.json()) as { id?: string };

    // Apply default tags polymorphically through core-tags. The
    // (source_module, source_type) come from splitting target_kind.
    const [sourceModule, sourceType] = tmpl.target_kind.split(":");
    const tags = tmpl.default_tags as string[];
    if (created.id && sourceModule && sourceType && tags.length > 0) {
      for (const tagName of tags) {
        try {
          await fetch(
            `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/core-tags/attachments`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                tag_name: tagName,
                source_module: sourceModule,
                source_type: sourceType,
                source_id: created.id,
              }),
            },
          );
          // 409 (already tagged) is fine — idempotent. Other errors
          // are non-fatal; the entity is created, tagging is best-
          // effort.
        } catch (err) {
          console.error(
            `[core-templates] tag "${tagName}" attach failed:`,
            (err as Error).message,
          );
        }
      }
    }

    void platform().events.emit("core-templates.template.instantiated", {
      orgId: ctx.org.id,
      templateId: tmpl.id,
      targetKind: tmpl.target_kind,
      entityId: created.id,
    });

    res.status(201).json(created);
  }),
);
