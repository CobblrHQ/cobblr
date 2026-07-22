// Platform-level routes for the registries + wires.
//
// All scoped to an org (auth + tenant context). Modules + web shell
// consume these to discover what kinds/actions exist, look up
// entities polymorphically, manage bindings, and run actions.

import { Router } from "express";
import { z } from "zod";
import { parseWireFilter } from "../platform/wire-filter.js";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { requireAuth } from "../auth/middleware.js";
import { requireCapability, requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import type { FieldOverrideBlob } from "../db/schema.js";
import { listEntries } from "../modules/registry.js";
import * as activity from "../platform/activity.js";
import { checkAvailability as checkAiAvailability } from "../platform/ai.js";
import { AiCapabilities, type AiCapability } from "@cobblr/platform-contract";
import { clearComputedDefsCache } from "../platform/computed-fields.js";
import { effectiveAppliesTo, matchAction, getActionScope } from "../platform/actions.js";
import type { ActionAppliesToDecl } from "@cobblr/platform-contract";
import {
  FIELD_SCOPE_PRESETS,
  TRAIT_NAMES,
  fieldScopeProfiles,
  fieldScopeSentinel,
  isFieldScope,
  parseFieldScope,
} from "@cobblr/platform-contract";
import { listAllFieldDefs, resolveFieldDefsForKind } from "../platform/field-defs.js";

export const platformOrgRouter = Router({ mergeParams: true });

// ──────────────────────── kinds + lookups ──────────────────────────

platformOrgRouter.get(
  "/:slug/entity-kinds",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // Org-scoped: manifest kinds + this workspace's synthesized instance
      // kinds (see listKindsForOrg) — search, MCP, and generic surfaces all
      // see instance items through the same registry.
      const items = await platform().entities.listKindsForOrg(req.tenant!.org.id);
      // ?include=custom_fields — merge THIS workspace's user field-defs onto
      // each kind, so a schema-reading consumer (the AI tool registry, the MCP
      // server, form builders) sees the WHOLE shape, not just the manifest's
      // native fields. Custom-field values live in the record's metadata blob;
      // the writers fold unknown body keys there (routeUnknownToMetadata), so
      // knowing the names/types is exactly what makes them settable.
      if (String(req.query.include ?? "").split(",").includes("custom_fields")) {
        const defs = await meta
          .selectFrom("module_field_defs")
          .select(["entity_kind", "name", "display_label", "type", "required", "choices"])
          .where("org_id", "=", req.tenant!.org.id)
          .orderBy("position")
          .execute();
        const byKind = new Map<string, Array<Record<string, unknown>>>();
        for (const d of defs) {
          const list = byKind.get(d.entity_kind) ?? [];
          list.push({
            name: d.name,
            label: d.display_label,
            type: d.type,
            required: d.required,
            ...(d.choices?.length ? { choices: d.choices } : {}),
          });
          byKind.set(d.entity_kind, list);
        }
        res.json({
          items: items.map((k) => ({ ...k, custom_fields: byKind.get(k.id) ?? [] })),
        });
        return;
      }
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

// Generic entity list — the cross-module read for any picker UI.
// GET /entities/:kind?q=&limit=&filter[x]=  → { items: ResolvedEntity[] }
// Projected through exposableFields for foreign callers, and gated by the
// viewer's per-field read-scope (member-facing callers don't see prices).
// Returns { items: [] } when the kind has no list resolver (the contract).
platformOrgRouter.get(
  "/:slug/entities/:kind",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const { kind } = req.params;
      if (!kind) {
        res.status(400).json({ error: { code: "missing_params", message: "kind required" } });
        return;
      }
      const filter: Record<string, unknown> = {};
      const raw = req.query.filter;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === "string") filter[k] = v;
        }
      }
      const result = await platform().entities.list(
        req.tenant!.org.id,
        kind,
        {
          q: typeof req.query.q === "string" ? req.query.q : undefined,
          limit: Math.min(Number(req.query.limit) || 50, 200),
          offset: Number(req.query.offset) || 0,
          filter: Object.keys(filter).length ? filter : undefined,
        },
        { userId: req.session?.id, role: req.tenant!.role },
      );
      res.json(result);
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
  // Optional: a workspace-scoped action has no record. For an entity-scoped
  // action they're required — enforced after we read the action's scope.
  entityKind: z.string().optional(),
  entityId: z.string().optional(),
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

      // A workspace-scoped action runs on the workspace, not a record — it
      // takes no entityKind/entityId and skips entity resolution. Read the
      // action's scope up front so we know which path to take. (null = the
      // action doesn't exist; treat as entity so invoke() throws its clear
      // "Unknown action" below.)
      const isWorkspaceAction =
        (await getActionScope(parsed.data.actionId)) === "workspace";
      if (
        !isWorkspaceAction &&
        (!parsed.data.entityKind || !parsed.data.entityId)
      ) {
        res.status(400).json({
          error: {
            code: "entity_required",
            message:
              "entityKind and entityId are required for this action (it runs on a record)",
          },
        });
        return;
      }

      // Look up the entity once (entity-scoped only) — we need its fields for
      // the namespaced ctx.entity block (Q2 resolution) and also for template
      // rendering if a binding template applies.
      const ent =
        !isWorkspaceAction && parsed.data.entityKind && parsed.data.entityId
          ? await platform().entities.lookup(
              req.tenant!.org.id,
              parsed.data.entityKind,
              parsed.data.entityId,
            )
          : null;
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
        scope: isWorkspaceAction ? "workspace" : "entity",
        entity: isWorkspaceAction
          ? undefined
          : {
              kind: parsed.data.entityKind!,
              id: parsed.data.entityId!,
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
        // Deprecated compat aliases (absent for workspace-scoped actions).
        entityKind: isWorkspaceAction ? undefined : parsed.data.entityKind,
        entityId: isWorkspaceAction ? undefined : parsed.data.entityId,
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
      if (parsed.data.filter != null) {
        const { error: ferr } = parseWireFilter(parsed.data.filter);
        if (ferr) {
          res.status(400).json({ error: { code: "invalid_wire_filter", message: ferr } });
          return;
        }
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
      if (parsed.data.filter != null) {
        const { error: ferr } = parseWireFilter(parsed.data.filter);
        if (ferr) {
          res.status(400).json({ error: { code: "invalid_wire_filter", message: ferr } });
          return;
        }
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
  "markdown",
  "qr",
]);

const FieldDefCreate = z.object({
  entity_kind: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  display_label: z.string().min(1),
  type: z.enum(["text", "number", "boolean", "date", "url", "richtext", "computed"]),
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
  /** The unit a type='number' value is measured in ("mm", "g", "in").
   *  Free text by design — the units vocabulary (core-units) resolves it
   *  at render/consume time and an unmatched string renders as-is. A unit
   *  resolving to a catalog category gives the field declared physical
   *  semantics (this is what size-aware features consume — never the
   *  field's name). */
  unit: z.string().trim().min(1).max(40).nullable().optional(),
  /** TRAIT SCOPE: attach this def to a CLASS of entity kinds instead of one kind
   *  ("origin", on everything physical). ANY combination of the 12 traits is
   *  valid — OR within an axis, AND across axes — matched by the same matcher the
   *  action registry uses. When present, `entity_kind` is DERIVED (the canonical
   *  sentinel) and whatever the client sent for it is ignored, so the sentinel can
   *  never disagree with the predicate it encodes. */
  applies_to: z
    .object({ traits: z.array(z.enum(TRAIT_NAMES)).min(1) })
    .optional(),
}).refine(
  (d) => !d.choices || d.type === "text",
  { message: "choices is only valid for type='text'", path: ["choices"] },
).refine(
  (d) => d.type !== "computed" || (d.template && d.template.trim().length > 0),
  { message: "template is required for type='computed'", path: ["template"] },
).refine(
  (d) => !d.unit || d.type === "number",
  { message: "unit is only valid for type='number'", path: ["unit"] },
);

const FieldDefPatch = z.object({
  display_label: z.string().min(1).optional(),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
  choices: z.array(z.string().max(120)).nullable().optional(),
  renderer: FieldRenderer.nullable().optional(),
  template: z.string().max(2000).nullable().optional(),
  /** Only meaningful on type='number' defs — validated against the row's
   *  type in the handler (the patch body alone can't see it). */
  unit: z.string().trim().min(1).max(40).nullable().optional(),
});

platformOrgRouter.get(
  "/:slug/field-defs",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : null;
      // ?effective=1 — apply the user override layer (native_field_overrides) so a
      // form gets the RESOLVED fields: relabel, hide (omitted), reorder. Config
      // surfaces (Presentation, composer, field detail) omit it to manage the raw
      // defs. Resolved at load = "rename on the fly", no data migration: the field
      // is still stored under `name`; only its presentation changes.
      const effective = req.query.effective === "1" || req.query.effective === "true";
      // Asking for ONE kind resolves trait-scoped defs onto it (a "@physical"
      // field lands on every physical kind, normalized to look per-kind — see
      // platform/field-defs.ts). Asking for ALL of them is the config read: the
      // scoped def appears once, as itself, not copied onto every kind it hits.
      const rawItems = kind
        ? await resolveFieldDefsForKind(req.tenant!.org.id, kind)
        : await listAllFieldDefs(req.tenant!.org.id);
      // Bundled fields carry their PARENT's identity so the UI can link to
      // bundle management ("uninstall the parent bundle to remove" must be a
      // door, not a dead end — the author, 2026-07-03).
      const bundleIds = [...new Set(rawItems.map((f) => f.bundle_id).filter((b): b is string => !!b))];
      const bundleRows = bundleIds.length
        ? await meta
            .selectFrom("bundles")
            .select(["id", "external_id", "name"])
            .where("id", "in", bundleIds)
            .execute()
        : [];
      const bundleById = new Map(bundleRows.map((b) => [b.id, b]));
      const items = rawItems.map((f) => ({
        ...f,
        bundle_external_id: f.bundle_id ? (bundleById.get(f.bundle_id)?.external_id ?? null) : null,
        bundle_name: f.bundle_id ? (bundleById.get(f.bundle_id)?.name ?? null) : null,
      }));
      if (!effective) {
        // The config read carries the two named ways to say "a class of things":
        //   broad   — "anything physical" (one or two axes, deliberately loose)
        //   profile — "every owned-thing" (a full 6-axis fingerprint, the same
        //             named shapes a module declares its kinds AS)
        // Neither is a separate mechanism: both just SET the trait grid, and any
        // combination of the 12 traits is a valid scope whether it has a name or
        // not. This list is a convenience, never the definition.
        res.json({
          items,
          scopes: [
            ...FIELD_SCOPE_PRESETS.map((p) => ({
              key: fieldScopeSentinel(p.traits),
              label: p.label,
              hint: p.hint,
              traits: p.traits,
              group: "broad" as const,
            })),
            ...fieldScopeProfiles().map((p) => ({ ...p, group: "profile" as const })),
          ],
        });
        return;
      }
      let oq = meta
        .selectFrom("native_field_overrides")
        .select(["entity_kind", "name", "display_label", "hidden", "position", "overrides"])
        .where("org_id", "=", req.tenant!.org.id);
      if (kind) oq = oq.where("entity_kind", "=", kind);
      const overrides = await oq.execute();
      const ov = new Map(overrides.map((o) => [`${o.entity_kind} ${o.name}`, o]));
      const resolved = items
        .map((f) => {
          const o = ov.get(`${f.entity_kind} ${f.name}`);
          if (!o) return { ...f, _hidden: false };
          // The user blob wins: relabel, reorder, and (1b) replace the dropdown
          // choices — all on top of the pristine bundle/module-owned field def.
          return {
            ...f,
            display_label: o.display_label ?? f.display_label,
            position: o.position ?? f.position,
            choices: o.overrides?.choices ?? f.choices,
            // The override layer's decode_role (P3) wins over the field-def's own,
            // mirroring choices — so a user/bundle can retarget a decode field.
            decode_role: o.overrides?.decode_role ?? f.decode_role,
            // Same for the record role: a bundle can mark an existing NATIVE field
            // (inventory's own `category`) as the table's grouping axis without a
            // schema change — exactly the seam decode_role opened for the VIN fields.
            field_role: o.overrides?.field_role ?? f.field_role,
            _hidden: o.hidden,
          };
        })
        .filter((f) => !f._hidden)
        .sort((a, b) => a.position - b.position)
        .map(({ _hidden, ...f }) => f);
      // Form-builder sections (for grouped form rendering). Cheap; only the
      // effective (form) read needs them.
      let sq = meta
        .selectFrom("field_sections")
        .select(["id", "name", "position"])
        .where("org_id", "=", req.tenant!.org.id)
        .orderBy("position")
        .orderBy("name");
      if (kind) sq = sq.where("entity_kind", "=", kind);
      const sections = await sq.execute();
      res.json({ items: resolved, sections });
    } catch (err) {
      next(err);
    }
  },
);

// ── Field sections (visual form builder) ────────────────────────────
// Named headings that group a kind's CUSTOM fields on the create/edit form.
// A field points at a section via module_field_defs.section_id (null =
// ungrouped). The builder saves a section's order + each field's section +
// position together via POST /field-defs/reorder.
platformOrgRouter.get("/:slug/field-sections", requireAuth, withTenant, async (req, res, next) => {
  try {
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    let q = meta
      .selectFrom("field_sections")
      .select(["id", "entity_kind", "name", "position"])
      .where("org_id", "=", req.tenant!.org.id)
      .orderBy("position")
      .orderBy("name");
    if (kind) q = q.where("entity_kind", "=", kind);
    res.json({ items: await q.execute() });
  } catch (err) {
    next(err);
  }
});

const SectionCreate = z.object({ entity_kind: z.string().min(1), name: z.string().min(1).max(120) });
platformOrgRouter.post("/:slug/field-sections", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = SectionCreate.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad section", details: p.error.issues } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const last = await meta
      .selectFrom("field_sections")
      .select("position")
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", p.data.entity_kind)
      .orderBy("position", "desc")
      .limit(1)
      .executeTakeFirst();
    const row = await meta
      .insertInto("field_sections")
      .values({ org_id: orgId, entity_kind: p.data.entity_kind, name: p.data.name, position: (last?.position ?? -1) + 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

const SectionPatch = z.object({ name: z.string().min(1).max(120).optional(), position: z.number().int().optional() });
platformOrgRouter.patch("/:slug/field-sections/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = SectionPatch.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad patch", details: p.error.issues } });
      return;
    }
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (p.data.name !== undefined) patch.name = p.data.name;
    if (p.data.position !== undefined) patch.position = p.data.position;
    const row = await meta
      .updateTable("field_sections")
      .set(patch as never)
      .where("id", "=", req.params.id!)
      .where("org_id", "=", req.tenant!.org.id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "section not found" } });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

platformOrgRouter.delete("/:slug/field-sections/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    // Fields fall back to ungrouped (section_id ON DELETE SET NULL).
    await meta
      .deleteFrom("field_sections")
      .where("id", "=", req.params.id!)
      .where("org_id", "=", req.tenant!.org.id)
      .execute();
    clearComputedDefsCache();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Bulk-save the form layout: section order + each field's section + position.
const FieldReorder = z.object({
  entity_kind: z.string().min(1),
  sections: z.array(z.object({ id: z.string().uuid(), position: z.number().int() })).optional(),
  fields: z.array(z.object({ name: z.string().min(1), section_id: z.string().uuid().nullable(), position: z.number().int() })).optional(),
});
platformOrgRouter.post("/:slug/field-defs/reorder", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = FieldReorder.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad reorder", details: p.error.issues } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const kind = p.data.entity_kind;
    await meta.transaction().execute(async (trx) => {
      for (const s of p.data.sections ?? []) {
        await trx
          .updateTable("field_sections")
          .set({ position: s.position, updated_at: new Date() })
          .where("id", "=", s.id)
          .where("org_id", "=", orgId)
          .where("entity_kind", "=", kind)
          .execute();
      }
      for (const f of p.data.fields ?? []) {
        await trx
          .updateTable("module_field_defs")
          .set({ position: f.position, section_id: f.section_id })
          .where("org_id", "=", orgId)
          .where("entity_kind", "=", kind)
          .where("name", "=", f.name)
          .execute();
      }
    });
    clearComputedDefsCache();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

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
  // 1b — custom dropdown choices that override the field's own. null = clear
  // (fall back to the base choices). Omitted = leave the blob's choices as-is.
  choices: z.array(z.string().max(120)).nullable().optional(),
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
      // Partial merge: a write that only sets `choices` must not wipe a relabel
      // (and vice versa). Read the existing row, layer the provided fields on top.
      const existing = await meta
        .selectFrom("native_field_overrides")
        .selectAll()
        .where("org_id", "=", req.tenant!.org.id)
        .where("entity_kind", "=", d.entity_kind)
        .where("name", "=", d.name)
        .executeTakeFirst();

      const blob: FieldOverrideBlob = { ...(existing?.overrides ?? {}) };
      if (d.choices !== undefined) {
        if (d.choices === null) delete blob.choices;
        else blob.choices = d.choices;
      }
      const display_label = d.display_label !== undefined ? d.display_label : (existing?.display_label ?? null);
      const hidden = d.hidden !== undefined ? d.hidden : (existing?.hidden ?? false);
      const position = d.position !== undefined ? d.position : (existing?.position ?? 0);
      const blobSql = sql`${JSON.stringify(blob)}::jsonb` as unknown as FieldOverrideBlob;

      const row = await meta
        .insertInto("native_field_overrides")
        .values({
          org_id: req.tenant!.org.id,
          entity_kind: d.entity_kind,
          name: d.name,
          display_label,
          hidden,
          position,
          overrides: blobSql,
          // A user edit CLAIMS the row as user-owned (bundle_id null) so the bundle
          // re-push can't clobber it (the install upsert only overwrites
          // bundle-owned rows). This is what makes the user layer win + survive.
          bundle_id: null,
        })
        .onConflict((c) =>
          c.columns(["org_id", "entity_kind", "name"]).doUpdateSet({
            display_label,
            hidden,
            position,
            overrides: blobSql,
            bundle_id: null,
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
      // A def is keyed either to ONE kind ("inventory:part") or to a TRAIT SCOPE —
      // any combination of the 12 traits, OR within an axis and AND across them.
      // The scope arrives either as an explicit predicate (the trait picker) or as
      // a sentinel shorthand ("@physical", "@physical+unique"); both collapse to
      // the same canonical trait list. The sentinel is then DERIVED from that list,
      // never taken from the client, so it can't disagree with the predicate it
      // encodes — and the same scope always lands on the same row.
      const scopeTraits =
        parsed.data.applies_to?.traits ?? parseFieldScope(parsed.data.entity_kind);
      if (isFieldScope(parsed.data.entity_kind) && scopeTraits.length === 0) {
        res.status(400).json({
          error: {
            code: "unknown_scope",
            message: `"${parsed.data.entity_kind}" isn't a trait scope. Use trait words, e.g. @physical or @physical+unique.`,
          },
        });
        return;
      }
      const entityKind = scopeTraits.length
        ? fieldScopeSentinel(scopeTraits)
        : parsed.data.entity_kind;
      const inserted = await meta
        .insertInto("module_field_defs")
        .values({
          org_id: req.tenant!.org.id,
          entity_kind: entityKind,
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
          unit: parsed.data.type === "number" ? parsed.data.unit ?? null : null,
          applies_to: scopeTraits.length
            ? sql`${JSON.stringify({ traits: scopeTraits })}::jsonb`
            : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      clearComputedDefsCache();
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "field_def_created",
        ref: { module: null, entityType: "field_def", entityId: inserted.id },
        diff: {
          entity_kind: entityKind,
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
      if (parsed.data.unit !== undefined) updates.unit = parsed.data.unit;

      // Provenance check: a `choices` change on a BUNDLE-owned field def routes to
      // the USER override layer (bundle_id null), never the bundle row — so the
      // "+ add option" can't be clobbered by the next bundle update. This is the
      // single chokepoint: every client (inventory's updateFieldDef, the platform
      // composer, …) PATCHes here, so none of them can clobber a bundle field.
      const def = await meta
        .selectFrom("module_field_defs")
        .selectAll()
        .where("id", "=", id)
        .where("org_id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      if (!def) {
        res.status(404).json({ error: { code: "not_found", message: "field def not found" } });
        return;
      }
      // A unit only makes sense on a number field — checked here because the
      // patch body alone can't see the row's type.
      if (parsed.data.unit != null && def.type !== "number") {
        res.status(400).json({
          error: { code: "invalid_body", message: "unit is only valid for type='number'" },
        });
        return;
      }
      let routedChoices = false;
      if (def.bundle_id && parsed.data.choices !== undefined) {
        const existing = await meta
          .selectFrom("native_field_overrides")
          .selectAll()
          .where("org_id", "=", req.tenant!.org.id)
          .where("entity_kind", "=", def.entity_kind)
          .where("name", "=", def.name)
          .executeTakeFirst();
        const blob: FieldOverrideBlob = { ...(existing?.overrides ?? {}) };
        if (parsed.data.choices === null) delete blob.choices;
        else blob.choices = parsed.data.choices;
        const blobSql = sql`${JSON.stringify(blob)}::jsonb` as unknown as FieldOverrideBlob;
        await meta
          .insertInto("native_field_overrides")
          .values({
            org_id: req.tenant!.org.id,
            entity_kind: def.entity_kind,
            name: def.name,
            display_label: existing?.display_label ?? null,
            hidden: existing?.hidden ?? false,
            position: existing?.position ?? 0,
            overrides: blobSql,
            bundle_id: null,
          })
          .onConflict((c) =>
            c.columns(["org_id", "entity_kind", "name"]).doUpdateSet({
              overrides: blobSql,
              bundle_id: null,
              updated_at: new Date(),
            }),
          )
          .execute();
        delete updates.choices;
        routedChoices = true;
      }

      if (Object.keys(updates).length === 0 && !routedChoices) {
        res.status(400).json({ error: { code: "no_changes", message: "no fields to update" } });
        return;
      }
      let updated = def;
      if (Object.keys(updates).length > 0) {
        const u = await meta
          .updateTable("module_field_defs")
          .set(updates as never)
          .where("id", "=", id)
          .where("org_id", "=", req.tenant!.org.id)
          .returningAll()
          .executeTakeFirst();
        if (!u) {
          res.status(404).json({ error: { code: "not_found", message: "field def not found" } });
          return;
        }
        updated = u;
      }
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "field_def_updated",
        ref: { module: null, entityType: "field_def", entityId: updated.id },
        diff: parsed.data,
      });
      clearComputedDefsCache();
      // Surface the EFFECTIVE choices so the caller immediately sees its override.
      res.json(routedChoices ? { ...updated, choices: parsed.data.choices ?? def.choices } : updated);
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
          const scope = a.scope === "workspace" ? "workspace" : "entity";
          // Workspace-scoped actions run on the workspace, not a record, so
          // they match no kind (their appliesTo is ignored). Force an empty
          // set rather than letting a default { any: true } match everything.
          const matchedKinds =
            scope === "workspace"
              ? []
              : kinds
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
            scope,
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
          const scope = a.scope === "workspace" ? "workspace" : "entity";
          // Workspace-scoped actions never match a kind (they run on the
          // workspace, not a record).
          const reason: ReturnType<typeof matchAction> =
            scope === "workspace"
              ? { via: null }
              : matchAction(
                  effective,
                  (kind.fields as { role?: string }[]) ?? [],
                  kind.id,
                  (kind.traits as Record<string, unknown> | null) ?? null,
                );
          return {
            id: a.id,
            label: a.label,
            scope,
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
        scope: action.scope === "workspace" ? "workspace" : "entity",
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
