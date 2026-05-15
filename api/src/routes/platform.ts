// Platform-level routes for the registries + wires.
//
// All scoped to an org (auth + tenant context). Modules + web shell
// consume these to discover what kinds/actions exist, look up
// entities polymorphically, manage bindings, and run actions.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import * as activity from "../platform/activity.js";
import { effectiveAppliesTo, matchAction } from "../platform/actions.js";
import type { ActionAppliesToDecl } from "@cobblr/platform-contract";

export const platformOrgRouter = Router({ mergeParams: true });

// ──────────────────────── kinds + lookups ──────────────────────────

platformOrgRouter.get(
  "/:slug/entity-kinds",
  requireAuth,
  withTenant,
  async (_req, res, next) => {
    try {
      const items = await platform().entities.listKinds();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.get(
  "/:slug/entities/:kind/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const { kind, id } = req.params;
      if (!kind || !id) {
        res.status(400).json({ error: { code: "missing_params", message: "kind + id required" } });
        return;
      }
      const found = await platform().entities.lookup(req.tenant!.org.id, kind, id);
      if (!found) {
        res.status(404).json({ error: { code: "not_found", message: "entity not found" } });
        return;
      }
      res.json(found);
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────────── actions ──────────────────────────────────

platformOrgRouter.get(
  "/:slug/actions",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : null;
      if (!kind) {
        res.status(400).json({ error: { code: "missing_kind", message: "?kind=<entity-kind> required" } });
        return;
      }
      // Filter applicable actions by org's installed modules.
      // orgId is passed so the matcher consults per-org appliesTo
      // overrides (configured via /actions/:id/predicate).
      const applicable = await platform().actions.listApplicable(
        kind,
        req.tenant!.org.id,
      );
      const installed = await meta
        .selectFrom("org_modules")
        .select("module_name")
        .where("org_id", "=", req.tenant!.org.id)
        .execute();
      const installedSet = new Set(installed.map((r) => r.module_name));
      // Pick up user bindings for this kind so the UI can offer them
      // as buttons alongside the module-declared actions.
      const bindings = await meta
        .selectFrom("entity_action_bindings as b")
        .innerJoin("entity_actions as a", "a.id", "b.action_id")
        .select([
          "b.id as binding_id",
          "b.action_id",
          "b.template",
          "a.label",
          "a.icon",
          "a.invoke_route",
          "a.invoke_handler",
        ])
        .where("b.org_id", "=", req.tenant!.org.id)
        .where("b.source_kind", "=", kind)
        .where("b.trigger_type", "=", "user-invoked")
        .where("b.enabled", "=", true)
        .execute();
      res.json({
        items: applicable.filter((a) => installedSet.has(a.module_name)),
        bindings,
      });
    } catch (err) {
      next(err);
    }
  },
);

const InvokeBody = z.object({
  actionId: z.string(),
  entityKind: z.string(),
  entityId: z.string(),
  bindingId: z.string().uuid().optional(),
  args: z.record(z.unknown()).optional(),
});

platformOrgRouter.post(
  "/:slug/actions/invoke",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const parsed = InvokeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad invoke payload", details: parsed.error.issues },
        });
        return;
      }
      // If a binding was selected, pull its template, render it
      // with the looked-up entity data, then invoke.
      let rendered: string | undefined;
      if (parsed.data.bindingId) {
        const b = await meta
          .selectFrom("entity_action_bindings")
          .select(["template"])
          .where("id", "=", parsed.data.bindingId)
          .where("org_id", "=", req.tenant!.org.id)
          .executeTakeFirst();
        if (b?.template) {
          const ent = await platform().entities.lookup(
            req.tenant!.org.id,
            parsed.data.entityKind,
            parsed.data.entityId,
          );
          rendered = platform().templates.render(b.template, {
            ...(ent?.fields ?? {}),
            _title: ent?.title ?? "",
          });
        }
      }

      const result = await platform().actions.invoke(parsed.data.actionId, {
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        entityKind: parsed.data.entityKind,
        entityId: parsed.data.entityId,
        rendered,
        args: parsed.data.args,
      });
      res.json({ ok: true, result });
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────────── bindings (wires) ─────────────────────────

const BindingCreate = z.object({
  source_kind: z.string(),
  action_id: z.string(),
  trigger_type: z
    .enum(["user-invoked", "event", "on-create", "on-update", "on-delete"])
    .default("user-invoked"),
  trigger_event: z.string().optional(),
  template: z.string().max(2000).optional(),
  filter: z.record(z.unknown()).optional(),
  args: z.record(z.unknown()).optional(),
});

platformOrgRouter.get(
  "/:slug/bindings",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const rows = await meta
        .selectFrom("entity_action_bindings")
        .selectAll()
        .where("org_id", "=", req.tenant!.org.id)
        .orderBy("created_at", "desc")
        .execute();
      res.json({ items: rows });
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.post(
  "/:slug/bindings",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const parsed = BindingCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad binding payload", details: parsed.error.issues },
        });
        return;
      }
      const inserted = await meta
        .insertInto("entity_action_bindings")
        .values({
          org_id: req.tenant!.org.id,
          source_kind: parsed.data.source_kind,
          action_id: parsed.data.action_id,
          trigger_type: parsed.data.trigger_type,
          trigger_event: parsed.data.trigger_event ?? null,
          template: parsed.data.template ?? null,
          filter: parsed.data.filter
            ? sql`${JSON.stringify(parsed.data.filter)}::jsonb`
            : null,
          args: parsed.data.args
            ? sql`${JSON.stringify(parsed.data.args)}::jsonb`
            : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "wire_created",
        ref: { module: null, entityType: "binding", entityId: inserted.id },
        diff: {
          source_kind: parsed.data.source_kind,
          action_id: parsed.data.action_id,
          trigger_type: parsed.data.trigger_type,
        },
      });
      res.status(201).json(inserted);
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.patch(
  "/:slug/bindings/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const Patch = z.object({
        template: z.string().nullable().optional(),
        enabled: z.boolean().optional(),
      });
      const parsed = Patch.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad patch", details: parsed.error.issues },
        });
        return;
      }
      const updated = await meta
        .updateTable("entity_action_bindings")
        .set({ ...parsed.data, updated_at: new Date() })
        .where("id", "=", id)
        .where("org_id", "=", req.tenant!.org.id)
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        res.status(404).json({ error: { code: "not_found", message: "binding not found" } });
        return;
      }
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "wire_updated",
        ref: { module: null, entityType: "binding", entityId: updated.id },
        diff: parsed.data,
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.delete(
  "/:slug/bindings/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const deleted = await meta
        .deleteFrom("entity_action_bindings")
        .where("id", "=", id)
        .where("org_id", "=", req.tenant!.org.id)
        .returning("id")
        .executeTakeFirst();
      if (!deleted) {
        res.status(404).json({ error: { code: "not_found", message: "binding not found" } });
        return;
      }
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "wire_deleted",
        ref: { module: null, entityType: "binding", entityId: deleted.id },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────────── field defs (Pillar D-lite) ───────────────

const FieldDefCreate = z.object({
  entity_kind: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  display_label: z.string().min(1),
  type: z.enum(["text", "number", "boolean", "date", "url"]),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
  /** When type='text', renders as a dropdown of these choices. */
  choices: z.array(z.string().max(120)).optional(),
}).refine(
  (d) => !d.choices || d.type === "text",
  { message: "choices is only valid for type='text'", path: ["choices"] },
);

const FieldDefPatch = z.object({
  display_label: z.string().min(1).optional(),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
  choices: z.array(z.string().max(120)).nullable().optional(),
});

platformOrgRouter.get(
  "/:slug/field-defs",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : null;
      let q = meta
        .selectFrom("module_field_defs")
        .selectAll()
        .where("org_id", "=", req.tenant!.org.id)
        .orderBy("entity_kind")
        .orderBy("position");
      if (kind) q = q.where("entity_kind", "=", kind);
      const items = await q.execute();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.post(
  "/:slug/field-defs",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const parsed = FieldDefCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad field def", details: parsed.error.issues },
        });
        return;
      }
      const inserted = await meta
        .insertInto("module_field_defs")
        .values({
          org_id: req.tenant!.org.id,
          entity_kind: parsed.data.entity_kind,
          name: parsed.data.name,
          display_label: parsed.data.display_label,
          type: parsed.data.type,
          required: parsed.data.required ?? false,
          position: parsed.data.position ?? 0,
          choices: parsed.data.choices
            ? (sql`${JSON.stringify(parsed.data.choices)}::jsonb` as unknown as string[])
            : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "field_def_created",
        ref: { module: null, entityType: "field_def", entityId: inserted.id },
        diff: {
          entity_kind: parsed.data.entity_kind,
          name: parsed.data.name,
          type: parsed.data.type,
        },
      });
      res.status(201).json(inserted);
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.patch(
  "/:slug/field-defs/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const parsed = FieldDefPatch.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad patch", details: parsed.error.issues },
        });
        return;
      }
      const updates: Record<string, unknown> = {};
      if (parsed.data.display_label !== undefined) updates.display_label = parsed.data.display_label;
      if (parsed.data.required !== undefined) updates.required = parsed.data.required;
      if (parsed.data.position !== undefined) updates.position = parsed.data.position;
      if (parsed.data.choices !== undefined) {
        updates.choices = parsed.data.choices
          ? sql`${JSON.stringify(parsed.data.choices)}::jsonb`
          : null;
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: { code: "no_changes", message: "no fields to update" } });
        return;
      }
      const updated = await meta
        .updateTable("module_field_defs")
        .set(updates as never)
        .where("id", "=", id)
        .where("org_id", "=", req.tenant!.org.id)
        .returningAll()
        .executeTakeFirst();
      if (!updated) {
        res.status(404).json({ error: { code: "not_found", message: "field def not found" } });
        return;
      }
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "field_def_updated",
        ref: { module: null, entityType: "field_def", entityId: updated.id },
        diff: parsed.data,
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.delete(
  "/:slug/field-defs/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const deleted = await meta
        .deleteFrom("module_field_defs")
        .where("id", "=", id)
        .where("org_id", "=", req.tenant!.org.id)
        .returning("id")
        .executeTakeFirst();
      if (!deleted) {
        res.status(404).json({ error: { code: "not_found", message: "field def not found" } });
        return;
      }
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "field_def_deleted",
        ref: { module: null, entityType: "field_def", entityId: deleted.id },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────── action-list + appliesTo overrides ────────────────
//
// GET    /:slug/registered-actions          — list all registered actions
//                                              with their effective predicate
// GET    /:slug/registered-actions/:id      — single action detail (default + override)
// PUT    /:slug/registered-actions/:id/predicate — write the per-org override
// DELETE /:slug/registered-actions/:id/predicate — revert to manifest default

platformOrgRouter.get(
  "/:slug/registered-actions",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const orgId = req.tenant!.org.id;
      const actions = await meta
        .selectFrom("entity_actions")
        .selectAll()
        .orderBy("id")
        .execute();
      const overrideRows = await meta
        .selectFrom("entity_action_org_overrides")
        .select(["action_id", "applies_to_override", "updated_at"])
        .where("org_id", "=", orgId)
        .execute();
      const overrides = new Map(
        overrideRows.map((r) => [
          r.action_id,
          {
            applies_to_override: r.applies_to_override,
            updated_at: r.updated_at,
          },
        ]),
      );
      // All entity kinds — needed to compute which kinds each action
      // currently matches (so the UI can show the live target set).
      const kinds = await meta
        .selectFrom("entity_kinds")
        .select(["id", "fields", "traits"])
        .orderBy("id")
        .execute();
      res.json({
        items: actions.map((a) => {
          const ovr = overrides.get(a.id);
          const effective = (ovr?.applies_to_override ??
            a.applies_to) as ActionAppliesToDecl;
          const matchedKinds = kinds
            .filter(
              (k) =>
                matchAction(
                  effective,
                  (k.fields as { role?: string }[]) ?? [],
                  k.id,
                  (k.traits as Record<string, unknown> | null) ?? null,
                ).via !== null,
            )
            .map((k) => k.id);
          return {
            id: a.id,
            module_name: a.module_name,
            label: a.label,
            description: a.description,
            icon: a.icon,
            default_applies_to: a.applies_to,
            effective_applies_to: effective,
            overridden: !!ovr,
            overridden_at: ovr?.updated_at ?? null,
            matched_kinds: matchedKinds,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /:slug/actions/inspect?kind=<entity-kind>
// Debugging surface: for one entity kind, every registered action
// with whether it matches and *why* (which sub-predicate hit). The
// transparency endpoint behind the wires/actions UI; also handy
// from the CLI.
platformOrgRouter.get(
  "/:slug/actions/inspect",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kindId = typeof req.query.kind === "string" ? req.query.kind : null;
      if (!kindId) {
        res
          .status(400)
          .json({ error: { code: "missing_kind", message: "?kind=<entity-kind> required" } });
        return;
      }
      const orgId = req.tenant!.org.id;
      const kind = await meta
        .selectFrom("entity_kinds")
        .select(["id", "display_name", "fields", "traits", "profile"])
        .where("id", "=", kindId)
        .executeTakeFirst();
      if (!kind) {
        res.status(404).json({ error: { code: "not_found", message: "entity kind not found" } });
        return;
      }
      const actions = await meta
        .selectFrom("entity_actions")
        .selectAll()
        .orderBy("id")
        .execute();
      const overrideRows = await meta
        .selectFrom("entity_action_org_overrides")
        .select(["action_id", "applies_to_override"])
        .where("org_id", "=", orgId)
        .execute();
      const overrides = new Map(
        overrideRows.map((r) => [r.action_id, r.applies_to_override]),
      );
      res.json({
        kind: {
          id: kind.id,
          display_name: kind.display_name,
          traits: kind.traits ?? null,
          profile: kind.profile ?? null,
        },
        actions: actions.map((a) => {
          const effective = (overrides.get(a.id) ??
            a.applies_to) as ActionAppliesToDecl;
          const reason = matchAction(
            effective,
            (kind.fields as { role?: string }[]) ?? [],
            kind.id,
            (kind.traits as Record<string, unknown> | null) ?? null,
          );
          return {
            id: a.id,
            label: a.label,
            effective_applies_to: effective,
            overridden: overrides.has(a.id),
            matched: reason.via !== null,
            match_reason: reason,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.get(
  "/:slug/registered-actions/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const action = await meta
        .selectFrom("entity_actions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!action) {
        res.status(404).json({ error: { code: "not_found", message: "action not found" } });
        return;
      }
      const result = await effectiveAppliesTo(id, req.tenant!.org.id);
      res.json({
        id: action.id,
        module_name: action.module_name,
        label: action.label,
        description: action.description,
        icon: action.icon,
        default_applies_to: result.default,
        effective_applies_to: result.effective,
        overridden: result.overridden,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PUT body shape matches ActionAppliesTo (same as the manifest
// declaration). Use DELETE on the same path to revert to default.
const PredicateOverrideBody = z.union([
  z.object({ any: z.literal(true) }),
  z
    .object({
      kinds: z.array(z.string()).min(1).optional(),
      traits: z.array(z.string()).min(1).optional(),
      hasFieldRole: z
        .enum(["title", "subtitle", "image", "summary", "quantity", "unit"])
        .optional(),
    })
    .refine(
      (d) => d.kinds || d.traits || d.hasFieldRole,
      "must specify at least one of kinds, traits, or hasFieldRole",
    ),
]);

platformOrgRouter.put(
  "/:slug/registered-actions/:id/predicate",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const parsed = PredicateOverrideBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "invalid_body",
            message: "Bad predicate override",
            details: parsed.error.issues,
          },
        });
        return;
      }
      const orgId = req.tenant!.org.id;
      // Verify the action exists before writing the FK reference.
      const action = await meta
        .selectFrom("entity_actions")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst();
      if (!action) {
        res.status(404).json({ error: { code: "not_found", message: "action not found" } });
        return;
      }
      // Upsert the override.
      await meta
        .insertInto("entity_action_org_overrides")
        .values({
          org_id: orgId,
          action_id: id,
          applies_to_override: sql`${JSON.stringify(parsed.data)}::jsonb`,
          updated_by: req.session!.id,
        })
        .onConflict((b) =>
          b
            .columns(["org_id", "action_id"])
            .doUpdateSet({
              applies_to_override: sql`${JSON.stringify(parsed.data)}::jsonb`,
              updated_at: new Date(),
              updated_by: req.session!.id,
            }),
        )
        .execute();
      await activity.log({
        orgId,
        action: "action_predicate_overridden",
        ref: { module: null, entityType: "action", entityId: id },
        diff: { applies_to_override: parsed.data },
      });
      const result = await effectiveAppliesTo(id, orgId);
      res.json({
        id,
        default_applies_to: result.default,
        effective_applies_to: result.effective,
        overridden: result.overridden,
      });
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.delete(
  "/:slug/registered-actions/:id/predicate",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const orgId = req.tenant!.org.id;
      const deleted = await meta
        .deleteFrom("entity_action_org_overrides")
        .where("org_id", "=", orgId)
        .where("action_id", "=", id)
        .returning("action_id")
        .executeTakeFirst();
      if (deleted) {
        await activity.log({
          orgId,
          action: "action_predicate_reverted",
          ref: { module: null, entityType: "action", entityId: id },
        });
      }
      const result = await effectiveAppliesTo(id, orgId);
      res.json({
        id,
        default_applies_to: result.default,
        effective_applies_to: result.effective,
        overridden: result.overridden,
      });
    } catch (err) {
      next(err);
    }
  },
);
