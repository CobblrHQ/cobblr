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
import { requireCapability, requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import * as activity from "../platform/activity.js";
import { checkAvailability as checkAiAvailability } from "../platform/ai.js";
import { AiCapabilities, type AiCapability } from "@cobblr/platform-contract";
import { clearComputedDefsCache } from "../platform/computed-fields.js";
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
      const found = await platform().entities.lookup(req.tenant!.org.id, kind, id, {
        userId: req.session?.id,
      });
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

// Resolver primitive — walk pairings from a source entity. The HTTP
// surface for what wires call internally via walkPairings(). Lets
// the wires-builder UI (and any cross-module renderer) drive
// pairing-traversal joins without duplicating the walk client-side.
//
// GET /entities/:kind/:id/pairings?rel=...&dir=in|out&kind=...
//   → { items: ResolvedEntity[] }  — already exposable-field-projected
//
// See docs/architecture/entity-resolver.md.
platformOrgRouter.get(
  "/:slug/entities/:kind/:id/pairings",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const { kind, id } = req.params;
      if (!kind || !id) {
        res.status(400).json({
          error: { code: "missing_params", message: "kind + id required" },
        });
        return;
      }
      const rel = typeof req.query.rel === "string" ? req.query.rel : null;
      if (!rel) {
        res.status(400).json({
          error: { code: "missing_rel", message: "?rel=<relationship_kind> required" },
        });
        return;
      }
      const dirParam = typeof req.query.dir === "string" ? req.query.dir : "in";
      if (dirParam !== "in" && dirParam !== "out") {
        res.status(400).json({
          error: { code: "bad_dir", message: "?dir must be 'in' or 'out'" },
        });
        return;
      }
      const kindFilter =
        typeof req.query.kind === "string" ? req.query.kind : undefined;
      const items = await platform().entities.walkPairings(
        req.tenant!.org.id,
        { kind, id },
        { rel, dir: dirParam, kind: kindFilter },
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

// core-resolver v0.1 — multi-hop walk over entity_pairings.
//
// POST /entities/:kind/:id/walk-path { hops: [{ rel, dir?, kind? }, ...], maxPerHop? }
//   → { items: ResolvedEntity[] }
//
// POST (not GET) because hops can be many and don't fit cleanly in
// a query string. Each hop's shape matches walkPairings's spec.
platformOrgRouter.post(
  "/:slug/entities/:kind/:id/walk-path",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const { kind, id } = req.params;
      if (!kind || !id) {
        res.status(400).json({
          error: { code: "missing_params", message: "kind + id required" },
        });
        return;
      }
      const body = req.body as {
        hops?: Array<{ rel?: string; dir?: string; kind?: string }>;
        maxPerHop?: number;
      };
      if (!Array.isArray(body.hops) || body.hops.length === 0) {
        res.status(400).json({
          error: { code: "missing_hops", message: "hops[] is required (1+ entries)." },
        });
        return;
      }
      // Validate each hop. Bad shape → 400 rather than a 500 from
      // walkPath calling rel="undefined".
      const cleanHops: Array<{ rel: string; dir?: "in" | "out"; kind?: string }> = [];
      for (const [i, h] of body.hops.entries()) {
        if (!h?.rel || typeof h.rel !== "string") {
          res.status(400).json({
            error: { code: "bad_hop", message: `hop ${i} missing rel` },
          });
          return;
        }
        if (h.dir && h.dir !== "in" && h.dir !== "out") {
          res.status(400).json({
            error: { code: "bad_dir", message: `hop ${i} dir must be 'in' or 'out'` },
          });
          return;
        }
        cleanHops.push({
          rel: h.rel,
          dir: h.dir as "in" | "out" | undefined,
          kind: typeof h.kind === "string" ? h.kind : undefined,
        });
      }
      const items = await platform().entities.walkPath(
        req.tenant!.org.id,
        { kind, id },
        cleanHops,
        { maxPerHop: typeof body.maxPerHop === "number" ? body.maxPerHop : undefined },
      );
      res.json({ items });
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
      // Authorize: owner/admin pass; members/guests need an explicit
      // grant for this specific action. Closes the hole where any
      // authenticated member (incl. a read-only guest) could invoke any
      // action — e.g. hand-firing inventory:adjust-stock to move stock.
      if (!(await requireCapability(req, res, parsed.data.actionId))) return;
      // Look up the entity once — we need its fields for the
      // namespaced ctx.entity block (Q2 resolution) and also for
      // template rendering if a binding template applies.
      const ent = await platform().entities.lookup(
        req.tenant!.org.id,
        parsed.data.entityKind,
        parsed.data.entityId,
      );
      const entityFields = ent?.fields ?? {};

      // Resolve actor metadata for the namespaced event.actor block.
      // Session already carries display_name + auth method + token id;
      // we only need an extra lookup for the api_token name when this
      // request was signed by a token.
      let api_token_name: string | null = null;
      if (req.session!.auth_method === "api_token" && req.session!.api_token_id) {
        const tokRow = await meta
          .selectFrom("api_tokens")
          .select("name")
          .where("id", "=", req.session!.api_token_id)
          .executeTakeFirst();
        api_token_name = tokRow?.name ?? null;
      }
      const actor = {
        user_id: req.session!.id,
        display_name: req.session!.display_name,
        auth_method: req.session!.auth_method,
        api_token_id: req.session!.api_token_id,
        api_token_name,
      };
      const firedAt = new Date().toISOString();

      // If a binding was selected, pull its template + render with
      // the entity's fields PLUS the namespaced event.* block so
      // templates can use `{{event.actor.display_name}}` etc.
      let rendered: string | undefined;
      if (parsed.data.bindingId) {
        const b = await meta
          .selectFrom("entity_action_bindings")
          .select(["template"])
          .where("id", "=", parsed.data.bindingId)
          .where("org_id", "=", req.tenant!.org.id)
          .executeTakeFirst();
        if (b?.template) {
          // Same template-data shape as wires.ts: payload fields
          // flatten onto event.* so {{event.delta}} works directly;
          // system-added keys come last to win on collision.
          rendered = platform().templates.render(b.template, {
            ...entityFields,
            _title: ent?.title ?? "",
            event: {
              ...(parsed.data.args ?? {}),
              name: null,
              actor,
              timestamp: firedAt,
              trigger_type: "user-invoked" as const,
            },
          });
        }
      }

      const result = await platform().actions.invoke(parsed.data.actionId, {
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        entity: {
          kind: parsed.data.entityKind,
          id: parsed.data.entityId,
          fields: entityFields,
        },
        event: {
          name: null, // user-invoked has no event name
          payload: parsed.data.args ?? {},
          actor,
          timestamp: firedAt,
          trigger_type: "user-invoked",
        },
        rendered,
        args: parsed.data.args,
        // Deprecated compat aliases.
        entityKind: parsed.data.entityKind,
        entityId: parsed.data.entityId,
      });
      res.json({ ok: true, result });
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────────── bindings (wires) ─────────────────────────

// Q1 wire target — see docs/architecture/wires-and-bundles.md.
// Mirror of the WireTarget schema in @cobblr/platform-contract; kept
// inline here to keep the route's request validation independent of
// the manifest contract (different concerns, same shape).
const BindingTarget = z.union([
  z.literal("self"),
  // No entity context — the action self-targets from its args (inbound-
  // webhook-style wires). See WireTarget in platform-contract.
  z.literal("none"),
  z.object({
    rel: z.string().min(1),
    dir: z.enum(["in", "out"]).optional(),
    kind: z.string().optional(),
  }),
]);

const BindingCreate = z
  .object({
    source_kind: z.string(),
    action_id: z.string(),
    trigger_type: z
      .enum(["user-invoked", "event", "on-create", "on-update", "on-delete", "schedule"])
      .default("user-invoked"),
    // .nullish() not .optional(): the web form sends `null` for an
    // unset field (not `undefined`), and `.optional()` rejected null —
    // which 400'd the default "user-invoked, no template" wire. The
    // superRefine checks below are truthiness-based, so null reads as
    // "absent" correctly, and the insert already coalesces `?? null`.
    trigger_event: z.string().nullish(),
    /** RRULE string for schedule-triggered wires (Q4). Null/absent for
     *  every other trigger type. See wires-and-bundles.md Q4. */
    trigger_schedule: z.string().nullish(),
    template: z.string().max(2000).nullish(),
    filter: z.record(z.unknown()).optional(),
    args: z.record(z.unknown()).optional(),
    /** What entity the action fires on. Default "self" (action runs on
     *  the source entity); object form opts into cross-module pairing
     *  traversal. See wires-and-bundles.md Q1. */
    target: BindingTarget.optional(),
  })
  .superRefine((data, ctx) => {
    // Cross-field correctness: each trigger type has a required
    // companion field. A wire missing its companion would silently
    // never fire — fail loud at create time instead.
    if (data.trigger_type === "event" && !data.trigger_event) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trigger_event is required when trigger_type is 'event'",
        path: ["trigger_event"],
      });
    }
    if (data.trigger_type === "schedule" && !data.trigger_schedule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "trigger_schedule (an RRULE) is required when trigger_type is 'schedule'",
        path: ["trigger_schedule"],
      });
    }
    if (data.trigger_type !== "event" && data.trigger_event) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "trigger_event is only meaningful when trigger_type is 'event' — remove it or change trigger_type",
        path: ["trigger_event"],
      });
    }
    if (data.trigger_type !== "schedule" && data.trigger_schedule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "trigger_schedule is only meaningful when trigger_type is 'schedule' — remove it or change trigger_type",
        path: ["trigger_schedule"],
      });
    }
  });

// The events an event-triggered wire can fire on — the union of every
// ENABLED module's manifest-declared `exposes.events`. Powers the wire
// composer's trigger-event typeahead so a user picks from real events
// instead of having to know the string (e.g. "purchases.order.arrived").
platformOrgRouter.get(
  "/:slug/wire-events",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const enabled = await meta
        .selectFrom("org_modules")
        .select("module_name")
        .where("org_id", "=", req.tenant!.org.id)
        .execute();
      const enabledNames = new Set(enabled.map((e) => e.module_name));
      const items: { event: string; module: string }[] = [];
      for (const entry of listEntries()) {
        if (!enabledNames.has(entry.manifest.name)) continue;
        for (const ev of entry.manifest.exposes?.events ?? []) {
          items.push({ event: ev, module: entry.manifest.name });
        }
      }
      items.sort((a, b) => a.event.localeCompare(b.event));
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

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
      // Wires drive automation (incl. privileged actions). Creating one is
      // an admin operation — not for read-only guests/members. Audit #3.
      if (!requireRole(req, res, "owner", "admin")) return;
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
          trigger_schedule: parsed.data.trigger_schedule ?? null,
          template: parsed.data.template ?? null,
          filter: parsed.data.filter
            ? sql`${JSON.stringify(parsed.data.filter)}::jsonb`
            : null,
          args: parsed.data.args
            ? sql`${JSON.stringify(parsed.data.args)}::jsonb`
            : null,
          // Default "self" (column default + explicit here so the
          // returning row carries it). Object form serialises to jsonb.
          target: parsed.data.target
            ? sql`${JSON.stringify(parsed.data.target)}::jsonb`
            : sql`'"self"'::jsonb`,
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
      if (!requireRole(req, res, "owner", "admin")) return;
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      // Full edit: any wire field may change, not just template/enabled — so a
      // user can re-point an existing wire (source kind / action / trigger /
      // args / target) from the composer without losing its id + firing
      // history. Every field is optional; only the ones present are written.
      const Patch = z.object({
        source_kind: z.string().optional(),
        action_id: z.string().optional(),
        trigger_type: z
          .enum(["user-invoked", "event", "on-create", "on-update", "on-delete", "schedule"])
          .optional(),
        trigger_event: z.string().nullish(),
        trigger_schedule: z.string().nullish(),
        template: z.string().max(2000).nullable().optional(),
        filter: z.record(z.unknown()).nullable().optional(),
        args: z.record(z.unknown()).nullable().optional(),
        target: BindingTarget.optional(),
        enabled: z.boolean().optional(),
      });
      const parsed = Patch.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad patch", details: parsed.error.issues },
        });
        return;
      }
      // Build the SET only from supplied keys; jsonb columns (filter/args/target)
      // serialise the same way the create route does.
      const d = parsed.data;
      const setObj: Record<string, unknown> = { updated_at: new Date() };
      if (d.source_kind !== undefined) setObj.source_kind = d.source_kind;
      if (d.action_id !== undefined) setObj.action_id = d.action_id;
      if (d.trigger_type !== undefined) setObj.trigger_type = d.trigger_type;
      if (d.trigger_event !== undefined) setObj.trigger_event = d.trigger_event ?? null;
      if (d.trigger_schedule !== undefined) setObj.trigger_schedule = d.trigger_schedule ?? null;
      if (d.template !== undefined) setObj.template = d.template ?? null;
      if (d.enabled !== undefined) setObj.enabled = d.enabled;
      if (d.filter !== undefined) setObj.filter = d.filter ? sql`${JSON.stringify(d.filter)}::jsonb` : null;
      if (d.args !== undefined) setObj.args = d.args ? sql`${JSON.stringify(d.args)}::jsonb` : null;
      if (d.target !== undefined) setObj.target = sql`${JSON.stringify(d.target)}::jsonb`;
      const updated = await meta
        .updateTable("entity_action_bindings")
        .set(setObj)
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
      if (!requireRole(req, res, "owner", "admin")) return;
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

const FieldRenderer = z.enum([
  "text",
  "color-hex",
  "image-url",
  "url-link",
  "year",
  "boolean",
  "code",
]);

const FieldDefCreate = z.object({
  entity_kind: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  display_label: z.string().min(1),
  type: z.enum(["text", "number", "boolean", "date", "url", "computed"]),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
  /** When type='text', renders as a dropdown of these choices. */
  choices: z.array(z.string().max(120)).optional(),
  /** Built-in renderer id for how the value should be drawn on
   *  detail pages + list rows. Null/omit = plain text. */
  renderer: FieldRenderer.nullable().optional(),
  /** When type='computed': the {{ }} template rendered read-only at
   *  resolve time. Required for computed; ignored otherwise. */
  template: z.string().max(2000).optional(),
}).refine(
  (d) => !d.choices || d.type === "text",
  { message: "choices is only valid for type='text'", path: ["choices"] },
).refine(
  (d) => d.type !== "computed" || (d.template && d.template.trim().length > 0),
  { message: "template is required for type='computed'", path: ["template"] },
);

const FieldDefPatch = z.object({
  display_label: z.string().min(1).optional(),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
  choices: z.array(z.string().max(120)).nullable().optional(),
  renderer: FieldRenderer.nullable().optional(),
  template: z.string().max(2000).nullable().optional(),
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

// Would an AI call work right now? Member-accessible (the providers list is
// admin-only — this leaks nothing but a boolean + why), so AI-consuming UI
// (the scan inbox) can warn about the degraded no-AI experience up front
// instead of failing quietly. Mirrors invoke()'s gauntlet: kill-switch →
// personal connection → workspace/managed provider → entitlement guard.
platformOrgRouter.get(
  "/:slug/ai-status",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const q = typeof req.query.capability === "string" ? req.query.capability : null;
      const capability = (AiCapabilities as readonly string[]).includes(q ?? "")
        ? (q as AiCapability)
        : undefined;
      const status = await checkAiAvailability(
        req.tenant!.org.id,
        req.session?.id ?? null,
        capability,
      );
      res.json(status);
    } catch (err) {
      next(err);
    }
  },
);

// Native-field presentation overrides (relabel / show-hide) for a kind. The
// entity forms read this to reshape their native fields; the config UI writes
// it. Mirrors /field-defs but targets the fields the module already declares.
platformOrgRouter.get(
  "/:slug/native-field-overrides",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : null;
      let q = meta
        .selectFrom("native_field_overrides")
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

const NativeFieldOverrideBody = z.object({
  entity_kind: z.string().min(1),
  name: z.string().min(1),
  display_label: z.string().max(160).nullable().optional(),
  hidden: z.boolean().optional(),
  position: z.number().int().optional(),
});

platformOrgRouter.put(
  "/:slug/native-field-overrides",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const parsed = NativeFieldOverrideBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "Bad override", details: parsed.error.issues } });
        return;
      }
      const d = parsed.data;
      const row = await meta
        .insertInto("native_field_overrides")
        .values({
          org_id: req.tenant!.org.id,
          entity_kind: d.entity_kind,
          name: d.name,
          display_label: d.display_label ?? null,
          hidden: d.hidden ?? false,
          position: d.position ?? 0,
        })
        .onConflict((c) =>
          c.columns(["org_id", "entity_kind", "name"]).doUpdateSet({
            display_label: d.display_label ?? null,
            hidden: d.hidden ?? false,
            position: d.position ?? 0,
            updated_at: new Date(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);

platformOrgRouter.delete(
  "/:slug/native-field-overrides/:entityKind/:name",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      await meta
        .deleteFrom("native_field_overrides")
        .where("org_id", "=", req.tenant!.org.id)
        .where("entity_kind", "=", req.params.entityKind!)
        .where("name", "=", req.params.name!)
        .execute();
      res.status(204).end();
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
          renderer: parsed.data.renderer ?? null,
          template: parsed.data.type === "computed" ? parsed.data.template ?? null : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      clearComputedDefsCache();
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
      if (parsed.data.renderer !== undefined) updates.renderer = parsed.data.renderer;
      if (parsed.data.template !== undefined) updates.template = parsed.data.template;
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
      clearComputedDefsCache();
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
      clearComputedDefsCache();
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
