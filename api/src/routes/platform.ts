import { markRequestReadOnly } from "../lib/request-context.js";
import { readGroupKeys } from "@cobblr/platform-contract/grouped-list";
import { makeSlidingWindowLimiter } from "@cobblr/platform-contract/rate-limit";
import { revealSecretField } from "../platform/secret-fields.js";
import { readRecordActionLayout, setRecordActionPin } from "../platform/record-action-layout.js";
import { commonBulkFields } from "../platform/bulk-set-field.js";
// Platform-level routes for the registries + wires.
//
// All scoped to an org (auth + tenant context). Modules + web shell
// consume these to discover what kinds/actions exist, look up
// entities polymorphically, manage bindings, and run actions.

import { choiceLearns } from "@cobblr/platform-contract/field-choices";
import { detailPathForEntity, titleForEntity } from "../platform/entities.js";
import { Router, type Request } from "express";
import { PLATFORM_ACTIONS } from "../platform/platform-actions.js";
import { z } from "zod";
import { BindingAsk, BindingLabel, bindingAskOf } from "@cobblr/platform-contract/binding-ask";
import { csvDownloadHeaders } from "@cobblr/platform-contract/csv";
import { parseWireFilter } from "../platform/wire-filter.js";
import { sql } from "kysely";
import { platform, isActionRefusal, crashSentence } from "@cobblr/platform-contract";
import { randomBytes } from "node:crypto";
import { requireAuth, appTokenMayInvoke } from "../auth/middleware.js";
import { requireCapability, requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { labelVia } from "./label-via.js";
import { actionRefusal, actionSafety } from "../platform/ai-action-door.js";
import { getTenantDb } from "../db/tenant.js";
import { listEntries } from "../modules/registry.js";
import { LIFECYCLE_TRIGGERS, isLifecycleTrigger, lifecycleRefusal } from "../platform/wire-lifecycle.js";
import * as activity from "../platform/activity.js";
import { checkAvailability as checkAiAvailability, aiChainFor, getProvider as getAiProvider, type AiChainStep } from "../platform/ai.js";
import { verificationFrom, verificationLabel } from "@cobblr/platform-contract/connection-verification";
import { hostedIdentifyReach } from "@cobblr/platform-contract/hosted-identify";
import { ocrAvailable } from "@cobblr/core-scan/services/ocr";
import { AiCapabilities, type AiCapability } from "@cobblr/platform-contract";
import { clearComputedDefsCache } from "../platform/computed-fields.js";
import { actionGateOf } from "../platform/action-gates.js";
import { issueUndos, issuedUndoFor, spendIssuedUndo } from "../platform/issued-undos.js";
import { actionRecordOptional, effectiveAppliesTo, enabledActionOwners, listDormant, matchAction, getActionScope, planFor, undoFor, hasUndo, isRequester } from "../platform/actions.js";
import { facesForKind } from "../platform/faces.js";
import { platformActionMinRole } from "../platform/platform-actions.js";
import { argChoicesFor } from "../platform/action-arg-choices.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { templateDataOf } from "@cobblr/platform-contract/entity-metadata";
import { namePeopleForTemplate } from "../platform/member-fields.js";
import type { ActionAppliesToDecl } from "@cobblr/platform-contract";
import {
  FIELD_ROLE_LABELS,
  FIELD_SCOPE_PRESETS,
  fieldScopeProfiles,
  fieldScopeSentinel,
} from "@cobblr/platform-contract";
import { fieldWithMeaning, meaningFromWords, sameMeaningGroups } from "@cobblr/platform-contract/field-meaning";
import { offerOnce, sellerOffer } from "../platform/seller-upgrade.js";
import {
  FieldDefCreate,
  FieldDefPatch,
  createFieldDef,
  deleteFieldDef,
  kindFieldsWithMeaning,
  listAllFieldDefs,
  resolveFieldDefsForKind,
  updateFieldDef,
  previewRetype,
} from "../platform/field-defs.js";
import { upsertNativeFieldOverride } from "../platform/native-field-overrides.js";
import { getScannableForModule } from "../platform/scan-registry.js";
import { FIELD_PRESETS, presetState } from "../platform/field-presets.js";
import { presetFieldStates, turnPresetOff, turnPresetOn } from "../platform/field-preset-switch.js";
import { fieldValuesUsed } from "../platform/field-values-used.js";
import { addressesUsed, nearestBias } from "../platform/addresses-used.js";
import { addressLookup, LOOKUP_MIN_CHARS, LOOKUP_TIMEOUT_MS } from "../platform/address-lookup.js";
import type { AddressValue } from "@cobblr/platform-contract/address";

/** The person's own assistant reading for them: an MCP client or the relay
 *  (the session's ai_door), or Cobb's read tools (x-cobblr-reader). It may
 *  see what the person wrote for themselves on their own records (#4798); a
 *  person sending the header themselves sees only what they can already read
 *  in the app. */
function readsAsAssistant(req: { session?: { ai_door?: string | null }; headers: Record<string, unknown> }): boolean {
  return !!req.session?.ai_door || String(req.headers["x-cobblr-reader"] ?? "").toLowerCase() === "assistant";
}

function secretPresenceQuery(raw: unknown): import("@cobblr/platform-contract").FilterPredicate[] | undefined {
  if (raw === undefined) return undefined;
  const values = z.record(z.enum(["empty", "has_value"])).parse(raw);
  return Object.entries(values).map(([col, value]) => ({ col, op: value === "empty" ? "empty" : "not_empty" }));
}

export const platformOrgRouter = Router({ mergeParams: true });
const allowSecretRead = makeSlidingWindowLimiter(60_000, 20);

// ROLE: any member (revealSecretField checks the field grant before decrypting or auditing).
// AI-REACH: exempt: secret values must never reach model context; only a person's explicit reveal or copy may read them.
platformOrgRouter.post("/:slug/entities/:kind/:id/fields/:field/reveal", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (readsAsAssistant(req)) {
      res.status(403).json({ error: { code: "secret_hidden", message: "A person must reveal this value themselves." } });
      return;
    }
    const operation = z.object({ operation: z.enum(["reveal", "copy"]) }).parse(req.body).operation;
    const userId = req.session!.id;
    if (!allowSecretRead(`${req.tenant!.org.id}:${userId}`)) {
      res.set("Retry-After", "60").status(429).json({ error: { code: "secret_read_limit", message: "Wait a minute before reading another secret." } });
      return;
    }
    const { kind, id, field } = req.params;
    const result = await revealSecretField(req.tenant!.org.id, kind!, id!, field!, { userId, role: req.tenant!.role }, operation);
    res.set("Cache-Control", "no-store").json(result);
  } catch (err) { next(err); }
});

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
      // count_field: the field that says how many things one record stands for
      // (a machine record counting five identical printers), where the owning
      // module declares that its list never also returns those things. A count of records and a
      // count of things are different answers, and a reader needs both.
      const items = (await platform().entities.listKindsForOrg(req.tenant!.org.id)).map((k) => {
        const sc = getScannableForModule(k.module_name);
        return sc?.qtyCountsThings && sc.qtyField ? { ...k, count_field: sc.qtyField } : k;
      });
      // ?include=custom_fields — merge THIS workspace's user field-defs onto
      // each kind, so a schema-reading consumer (the AI tool registry, the MCP
      // server, form builders) sees the WHOLE shape, not just the manifest's
      // native fields. Custom-field values live in the record's metadata blob;
      // a writer names them at the top level and a name that is not here is
      // refused, so knowing the names/types is exactly what makes them settable.
      if (String(req.query.include ?? "").split(",").includes("custom_fields")) {
        const defs = await meta
          .selectFrom("module_field_defs")
          .select(["entity_kind", "name", "display_label", "type", "required", "choices", "help", "applies_to", "unit", "field_role", "learns", "bundle_id", "source_module"])
          .where("org_id", "=", req.tenant!.org.id)
          .orderBy("position")
          .execute();
        // A workspace-wide field (every physical thing: "Acquired from") is a
        // field of each kind it applies to, and its form shows it there. A
        // schema reader that saw only the kind's own defs could not discover
        // the field it was meant to fill (#3855). Only a workspace that has
        // such fields pays for resolving them, once per kind.
        const scopedByKind = new Map<string, Array<Record<string, unknown>>>();
        if (defs.some((d) => d.applies_to != null)) {
          await Promise.all(
            items.map(async (k) => {
              const effective = await resolveFieldDefsForKind(req.tenant!.org.id, k.id);
              const scoped = effective.filter((d) => d.scope);
              if (!scoped.length) return;
              scopedByKind.set(
                k.id,
                scoped.map((d) => ({
                  name: d.name,
                  label: d.display_label,
                  type: d.type,
                  required: d.required,
                  ...(Array.isArray(d.choices) && d.choices.length ? { choices: d.choices } : {}),
                  ...(d.help ? { help: d.help } : {}),
                  ...(d.unit ? { unit: d.unit } : {}),
                  ...(d.field_role ? { field_role: d.field_role } : {}),
                  ...(choiceLearns(d as never) ? { learns: true } : {}),
                  scope: d.scope_label ?? d.scope,
                })),
              );
            }),
          );
        }
        const byKind = new Map<string, Array<Record<string, unknown>>>();
        for (const d of defs) {
          const list = byKind.get(d.entity_kind) ?? [];
          list.push({
            name: d.name,
            label: d.display_label,
            type: d.type,
            required: d.required,
            ...(d.choices?.length ? { choices: d.choices } : {}),
            // What the field MEANS, in the words the record's form shows
            // under it: "Replacement value" is not what you paid, and a
            // reader of the record needs that as much as a person does.
            ...(d.help ? { help: d.help } : {}),
            // A unit or a meaning that makes it money ("USD", "acquired-for"),
            // so a reader shows "$4,300" (@cobblr/platform-contract/money).
            ...(d.unit ? { unit: d.unit } : {}),
            ...(d.field_role ? { field_role: d.field_role } : {}),
            // A list that takes a new value (and so learns it), against one
            // that only takes its own choices: an agent reads this before it
            // sends a spelling (#4537).
            ...(choiceLearns(d) ? { learns: true } : {}),
          });
          byKind.set(d.entity_kind, list);
        }
        // A native field this workspace relabels ("cost" shows as "Paid" in
        // a Home Inventory): the same word the form uses, on the kind.
        const relabels = await meta
          .selectFrom("native_field_overrides")
          .select(["entity_kind", "name", "display_label"])
          .where("org_id", "=", req.tenant!.org.id)
          .where("display_label", "is not", null)
          .execute();
        const labelOf = new Map(relabels.map((r) => [`${r.entity_kind} ${r.name}`, r.display_label as string]));
        res.json({
          items: items.map((k) => ({
            ...k,
            ...(Array.isArray(k.fields)
              ? { fields: k.fields.map((f) => { const label = labelOf.get(`${k.id} ${f.name}`); return label ? { ...f, label } : f; }) }
              : {}),
            custom_fields: [...(byKind.get(k.id) ?? []), ...(scopedByKind.get(k.id) ?? [])],
          })),
        });
        return;
      }
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

// Any collection as a spreadsheet, read as the viewer: fields their role may
// not read are neither a column nor a value. Registered before /:kind/:id,
// which would otherwise take "export.csv" for a record id.
// AI-REACH: exempt (a file download for a person; secret values require an explicit audited owner/admin choice and never reach the assistant)
platformOrgRouter.get(
  "/:slug/entities/:kind/export.csv",
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
      const includeSecrets = req.query.include_secrets === "true" || req.query.include_secrets === "1";
      if (includeSecrets && readsAsAssistant(req)) {
        res.status(403).json({ error: { code: "secret_hidden", message: "A person must export secrets themselves." } });
        return;
      }
      const raw = req.query.filter;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === "string") filter[k] = v;
        }
      }
      const out = await platform().entities.exportCsv(
        req.tenant!.org.id,
        kind,
        {
          q: typeof req.query.q === "string" && req.query.q ? req.query.q : undefined,
          filter: Object.keys(filter).length ? filter : undefined,
          where: secretPresenceQuery(req.query.presence),
          ...(req.query.include_retired === "1" || req.query.include_retired === "true" ? { include_retired: true } : {}),
        },
        { userId: req.session?.id, role: req.tenant!.role },
        undefined,
        { includeSecrets },
      );
      if (!out) {
        res.status(404).json({ error: { code: "unknown_kind", message: "There is no collection of that kind here." } });
        return;
      }
      res.locals.secretExport = includeSecrets;
      if (includeSecrets) res.set("Cache-Control", "no-store");
      res.set(csvDownloadHeaders(out.filename, out.complete)).send(out.csv);
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
        role: req.tenant!.role,
        ...(readsAsAssistant(req) ? { assistant: true } : {}),
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

// Where a record lives: the one address every link to it should use, decided
// by the record's own collection (detailPathForEntity), for a surface that has
// only a kind and an id. The web's open door (/open/:kind/:id) asks this and
// goes there, so a row naming the base kind of an item filed in a named
// collection still opens that item rather than "part not found" (#3623).
// AI-REACH: reads
platformOrgRouter.get(
  "/:slug/entities/:kind/:id/address",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const { kind, id } = req.params;
      if (!kind || !id) {
        res.status(400).json({ error: { code: "missing_params", message: "kind + id required" } });
        return;
      }
      const orgId = req.tenant!.org.id;
      // A record that no longer resolves has no address; the door says so
      // rather than opening an empty page.
      if ((await titleForEntity(orgId, kind, id)) === null) {
        res.status(404).json({ error: { code: "not_found", message: "That record is not here any more." } });
        return;
      }
      const path = await detailPathForEntity(orgId, kind, id);
      if (!path) {
        res.status(404).json({ error: { code: "no_page", message: "That kind of record has no page to open." } });
        return;
      }
      res.json({ path });
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
    markRequestReadOnly();
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
          group_by: typeof req.query.group_by === "string" ? req.query.group_by : undefined,
          group_offset: Math.max(Number(req.query.group_offset) || 0, 0),
          group_limit: Math.min(Math.max(Number(req.query.group_limit) || 20, 1), 20),
          group_keys: typeof req.query.group_keys === "string" ? readGroupKeys(req.query.group_keys) : undefined,
          q: typeof req.query.q === "string" ? req.query.q : undefined,
          limit: Math.min(Number(req.query.limit) || 50, 200),
          offset: Number(req.query.offset) || 0,
          filter: Object.keys(filter).length ? filter : undefined,
          where: secretPresenceQuery(req.query.presence),
          ...(req.query.include_retired === "1" || req.query.include_retired === "true" ? { include_retired: true } : {}),
        },
        { userId: req.session?.id, role: req.tenant!.role, ...(readsAsAssistant(req) ? { assistant: true } : {}) },
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
// AI-REACH: a read. POST only because a list of hops does not fit a query
// string; it writes nothing, and the assistant reads pairings with its own tools.
// UI-REACH: a read sent as POST because its hops do not fit a query string
platformOrgRouter.post(
  "/:slug/entities/:kind/:id/walk-path",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // ROLE: any member (a read: following links, POST only for the path's shape)
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

// GET /:slug/faces?kind=<entity-kind> — which faces a collection wears.
//
// The one answer every record surface reads before deciding what to show:
// the strip, the contributed panels, and a module's own detail page all ask
// this instead of keeping their own rule. Meta-side, so it is cheap.
//
// AI-REACH: exempt — a read the assistant gets through list_kinds; nothing to invoke.
platformOrgRouter.get("/:slug/faces", requireAuth, withTenant, async (req, res, next) => {
  try {
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    if (!kind) {
      res.status(400).json({ error: { code: "missing_kind", message: "?kind=<entity-kind> required" } });
      return;
    }
    res.json(await facesForKind(req.tenant!.org.id, kind));
  } catch (err) {
    next(err);
  }
});

// AI-REACH: a person's own pins are display preferences, not workspace configuration.
platformOrgRouter.put("/:slug/record-action-pins", requireAuth, withTenant, async (req, res, next) => {
  // ROLE: any member (only their own account's pins are written)
  try {
    const parsed = z.object({ kind: z.string().min(1).max(160), action: z.string().min(1).max(160), pinned: z.boolean() }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: { code: "invalid_body", message: "Choose an action and whether to pin it." } }); return; }
    try { await setRecordActionPin(req.tenant!.org.id, parsed.data.kind, req.session!.id, parsed.data.action, parsed.data.pinned); }
    catch (err) { if ((err as Error).message.startsWith("Four actions")) { res.status(409).json({ error: { code: "pin_limit", message: (err as Error).message } }); return; } throw err; }
    res.status(204).end();
  } catch (err) { next(err); }
});
platformOrgRouter.get("/:slug/record-action-layout", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (typeof req.query.kind !== "string") { res.status(400).json({ error: { code: "missing_kind", message: "Choose a record kind." } }); return; }
    res.json(await readRecordActionLayout(req.tenant!.org.id, req.query.kind, req.session!.id));
  } catch (err) { next(err); }
});

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
          // The binding's own label when it has one ("Open a bottle"), else
          // the action's ("Use one").
          sql<string>`coalesce(b.label, a.label)`.as("label"),
          "b.ask",
          // What it actually does, in the module's own words. A row shows the
          // LABEL, and "Print label" does not say whether paper comes out now
          // or a line joins the queue; the description does ("Queue a
          // printable label for this entity").
          "a.description",
          "a.action_group as group",
          "a.is_primary as primary",
          "a.icon",
          "a.invoke_route",
          "a.invoke_handler",
          // Whether a mistaken run can be put right. A binding rendered on a
          // LIST row is one thumb away from firing by accident, so the surface
          // needs to know which ones deserve a second tap. Printing a label is
          // the motivating case: nothing breaks, but a label comes out.
          "a.undoable",
          // What the button already carries and what the action requires, so
          // a press asks for whatever is still missing instead of meeting the
          // door's refusal (#3865).
          "b.args",
          "a.args_schema",
        ])
        .where("b.org_id", "=", req.tenant!.org.id)
        .where("b.source_kind", "=", kind)
        .where("b.trigger_type", "=", "user-invoked")
        .where("b.enabled", "=", true)
        .execute();
      // What the record would offer with a module turned on: a door, never a
      // button that runs (#3883). Best-effort: a registry hiccup here costs
      // the doors, never the record's real actions.
      const dormant = await listDormant(kind, req.tenant!.org.id).catch(() => []);
      const choose = await argChoicesFor(req.tenant!.org.id, kind, [...applicable.map((a) => a.args_schema), ...bindings.map((b) => b.args_schema)]);
      const writer = await platform().entities.getWriter(req.tenant!.org.id, kind).catch(() => null);
      res.json({
        items: applicable.filter((a) => installedSet.has(a.module_name)).map((a) => ({ ...a, args_schema: choose(a.args_schema) })),
        ...(await readRecordActionLayout(req.tenant!.org.id, kind, req.session!.id)),
        dormant: dormant.map((a) => ({ group: a.group, primary: a.primary, id: a.id, label: a.label, description: a.description, icon: a.icon, module_name: a.module_name, module_label: a.module_label })),
        bindings: bindings.map((b) => ({ ...b, args_schema: choose(b.args_schema), ask: bindingAskOf(b.ask) })),
        lifecycle: !!(writer?.retire && writer.unretire),
      });
    } catch (err) {
      next(err);
    }
  },
);


const InvokeBody = z.object({
  // Not merely a string: "" matched no action, read as record-scoped, and was
  // refused with "entityKind and entityId are required" - a message about the
  // wrong thing, which is how a missing action id hid for a day (2026-09-11).
  actionId: z.string().min(1, "actionId is required"),
  // Optional: a workspace-scoped action has no record. For an entity-scoped
  // action they're required — enforced after we read the action's scope.
  entityKind: z.string().optional(),
  entityId: z.string().optional(),
  bindingId: z.string().uuid().optional(),
  args: z.record(z.unknown()).optional(),
});

/** The arguments a binding was given, under what this press adds. A button a
 *  collection declared ("Buy again" → `{ listTitle: "Shopping list" }`) ran
 *  with its template and none of its arguments, so every binding with args
 *  behaved like the bare action. What the person answered (the ask) wins over
 *  what the binding fixed. */
async function withBindingArgs(
  orgId: string,
  bindingId: string | undefined,
  actionId: string,
  args: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!bindingId) return args;
  // Only a binding OF this action lends its arguments: an id sent beside a
  // different action must not hand that action somebody else's args.
  const b = await meta
    .selectFrom("entity_action_bindings")
    .select(["args"])
    .where("id", "=", bindingId)
    .where("org_id", "=", orgId)
    .where("action_id", "=", actionId)
    .executeTakeFirst();
  const fixed = b?.args && typeof b.args === "object" && !Array.isArray(b.args) ? (b.args as Record<string, unknown>) : null;
  if (!fixed) return args;
  return { ...fixed, ...(args ?? {}) };
}

/** The door has one slot called entityKind, for the record an action runs
 *  on, and the field actions take an argument of the same name for the kind
 *  whose field they change. A workspace action arrived with the kind in the
 *  slot and none in its args, and refused ("entity_kind and field are
 *  required", from "remove tea category from inventory"). A workspace action
 *  has no record, so a kind in that slot can only mean the argument; it is
 *  folded in when the args do not name one. */
function argsOf(body: z.infer<typeof InvokeBody>, isWorkspaceAction: boolean): Record<string, unknown> | undefined {
  if (isWorkspaceAction && body.entityKind && !body.entityId && body.args?.entity_kind === undefined) {
    return { ...(body.args ?? {}), entity_kind: body.entityKind };
  }
  return body.args;
}

/** A plan is asked with the same body as a run, plus what the earlier steps
 *  of the same plan will have done (`ActionInvokeContext.before`). */
const PlanBody = InvokeBody.extend({
  before: z.array(z.object({ op: z.literal("delete"), kind: z.string().min(1), id: z.string().min(1) })).max(200).optional(),
});

// POST /:slug/actions/plan — what an action WOULD touch, before anyone runs
// it: the list a confirm card shows. Same body and same gate as invoke; it
// writes nothing. An action with no planner answers { plan: null } and its
// card falls back to the action's label.
// AI-REACH: exempt — a read the confirm card makes about a change already proposed, not a capability
platformOrgRouter.post(
  "/:slug/actions/plan",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const parsed = PlanBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad plan payload", details: parsed.error.issues },
        });
        return;
      }
      if (!(await requireCapability(req, res, parsed.data.actionId))) return;
      const isWorkspaceAction = (await getActionScope(parsed.data.actionId)) === "workspace";
      const args = await withBindingArgs(req.tenant!.org.id, parsed.data.bindingId, parsed.data.actionId, argsOf(parsed.data, isWorkspaceAction));
      const plan = await planFor(parsed.data.actionId, {
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        scope: isWorkspaceAction ? "workspace" : "entity",
        ...(!isWorkspaceAction && parsed.data.entityKind && parsed.data.entityId
          ? { entity: { kind: parsed.data.entityKind, id: parsed.data.entityId } }
          : {}),
        event: {
          name: null,
          payload: args ?? {},
          actor: {
            user_id: req.session!.id,
            display_name: req.session!.display_name,
            auth_method: req.session!.auth_method,
            api_token_id: req.session!.api_token_id,
            api_token_name: null,
          },
          timestamp: new Date().toISOString(),
          trigger_type: "user-invoked",
        },
        args: args ?? {},
        ...(parsed.data.before?.length ? { before: parsed.data.before } : {}),
      });
      // { plan } or { plan: null, error }: the reason travels, so the caller
      // can hand it to the model instead of falling back to a bare label.
      if (plan && "error" in plan) {
        res.json({ plan: null, error: plan.error });
        return;
      }
      res.json({ plan });
    } catch (e) {
      next(e);
    }
  },
);

/** The origin a person's request came from, for a handler that must mint an
 *  absolute URL: the isolated-stack e2e header wins, else protocol + host,
 *  the same rule the labels module's own routes use for a QR base. */
function requestOrigin(req: Request): string {
  const header = req.headers["x-cobblr-base-url"];
  if (typeof header === "string" && header.trim()) return header.trim().replace(/\/+$/, "");
  // HOST-OK: an action's result links go back in this caller's own answer.
  return `${req.protocol}://${req.headers.host ?? "localhost"}`;
}

/** The kinds an action on `kind` touches, for the client's refresh: the kind
 *  as invoked and its base kind when it is an instance's (`groceries:item`
 *  and `inventory:part` name the same rows). Null for a workspace action. */
async function affectedKindsOf(orgId: string, kind: string | null): Promise<string[]> {
  if (!kind) return [];
  const kinds = new Set([kind]);
  try {
    const r = await platform().entities.resolveKind(orgId, kind);
    if (r?.base) kinds.add(r.base);
  } catch {
    /* an unknown kind still names itself */
  }
  return [...kinds];
}

// AI-REACH: this IS the door. Every action the assistant runs arrives here,
// so giving it one of its own would be a door into the door.
platformOrgRouter.post(
  "/:slug/actions/invoke",
  requireAuth,
  withTenant,
  labelVia,
  async (req, res, next) => {
    try {
      const parsed = InvokeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad invoke payload", details: parsed.error.issues },
        });
        return;
      }
      // A Tier-B app-scoped token may fire capability-gated MODULE actions but
      // never a kernel workspace-config one (`platform:*`). requireCapability
      // below is not enough: an owner/admin identity passes it implicitly, so a
      // managed-app bundle running under one could otherwise disable a module or
      // rename the workspace. Server-side twin of the Player's client mediator.
      if (req.session?.app_scope && !appTokenMayInvoke(parsed.data.actionId)) {
        res.status(403).json({
          error: {
            code: "app_token_out_of_scope",
            message:
              "An app token may not invoke workspace-configuration (platform:*) actions.",
          },
        });
        return;
      }

      // An assistant with no way to show a person a confirmation (any MCP
      // door, or the in-app chat's relay) never runs an action that needs
      // one. Asked here because every door arrives here; asking only in the
      // relay's tool call left the others running it unasked.
      if (req.session?.ai_door) {
        const refused = actionRefusal(await actionSafety(parsed.data.actionId));
        if (refused) {
          res.status(403).json({ error: { code: "needs_a_person", message: refused } });
          return;
        }
      }

      // Authorize: owner/admin pass; members/guests need an explicit
      // grant for this specific action. Closes the hole where any
      // authenticated member (incl. a read-only guest) could invoke any
      // action — e.g. hand-firing inventory:adjust-stock to move stock.
      // An undo the platform handed this person for their own run is theirs
      // to run, whatever their role (#5193): exactly that step, once.
      const ownUndo = await issuedUndoFor(req.tenant!.org.id, req.session!.id, {
        action_id: parsed.data.actionId,
        args: parsed.data.args ?? {},
        entity_kind: parsed.data.entityKind ?? null,
        entity_id: parsed.data.entityId ?? null,
      });
      // And what a person started is theirs to answer, cancel or confirm,
      // whatever their role (#5192): the action names who started its target.
      const asRequester = (ownUndo ? await spendIssuedUndo(ownUndo) : false) || actionGateOf(parsed.data.actionId).runBy === "requester" && await isRequester(parsed.data.actionId, req.session!.id, {
        orgId: req.tenant!.org.id,
        args: parsed.data.args ?? {},
        ...(parsed.data.entityKind && parsed.data.entityId ? { entity: { kind: parsed.data.entityKind, id: parsed.data.entityId } } : {}),
      });
      if (!asRequester && !(await requireCapability(req, res, parsed.data.actionId))) return;

      // Per-action role FLOOR — parity with the REST twin (audit
      // M-ACTION-PARITY). requireCapability lets any admin through, but some
      // kernel actions are owner-only over REST (platform:rename-workspace is
      // hard `role === "owner"` on PATCH /orgs/:slug). Without this the action
      // rail would be more permissive than the settings UI for the SAME
      // operation, so an admin could rename through Cobb / the generic invoke
      // what they cannot rename in Settings. roleSatisfies is rank-based, so a
      // higher role always clears a lower floor.
      const minRole = platformActionMinRole(parsed.data.actionId);
      if (minRole && !roleSatisfies(req.tenant!.role, [minRole])) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: `The ${parsed.data.actionId} action requires the ${minRole} role.`,
            details: {
              action_id: parsed.data.actionId,
              required_role: minRole,
              your_role: req.tenant!.role,
            },
          },
        });
        return;
      }

      // A workspace-scoped action runs on the workspace, not a record — it
      // takes no entityKind/entityId and skips entity resolution. Read the
      // action's scope up front so we know which path to take. (null = the
      // action doesn't exist; treat as entity so invoke() throws its clear
      // "Unknown action" below.)
      const isWorkspaceAction =
        (await getActionScope(parsed.data.actionId)) === "workspace";
      const args = await withBindingArgs(req.tenant!.org.id, parsed.data.bindingId, parsed.data.actionId, argsOf(parsed.data, isWorkspaceAction));
      // An entity action that may also run with no record (its manifest says
      // `recordOptional`) is let through without one: "put milk on the
      // shopping list" has no record to name (#3255).
      const hasRecord = Boolean(parsed.data.entityKind && parsed.data.entityId);
      if (!isWorkspaceAction && !hasRecord && !(await actionRecordOptional(parsed.data.actionId))) {
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
            ...(ent ? await namePeopleForTemplate(req.tenant!.org.id, ent.kind, templateDataOf(entityFields)) : templateDataOf(entityFields)),
            _title: ent?.title ?? "",
            event: {
              ...(args ?? {}),
              name: null,
              actor,
              timestamp: firedAt,
              trigger_type: "user-invoked" as const,
            },
          });
        }
      }

      // A handler that throws is answered the way a handler that refuses is:
      // 200, `result.ok:false`, and a sentence. A bare 500 here hid
      // "no label base URL is set ... set one under Configuration" behind
      // "Internal server error" and a flash of ERR on the button (#2847).
      // Only the handler's run is caught; a bug in the route itself is
      // still a 500.
      let result: unknown;
      try {
        result = await platform().actions.invoke(parsed.data.actionId, {
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        origin: requestOrigin(req),
        scope: isWorkspaceAction ? "workspace" : "entity",
        entity: isWorkspaceAction || !hasRecord
          ? undefined
          : {
              kind: parsed.data.entityKind!,
              id: parsed.data.entityId!,
              fields: entityFields,
            },
        event: {
          name: null, // user-invoked has no event name
          payload: args ?? {},
          actor,
          timestamp: firedAt,
          trigger_type: "user-invoked",
        },
        rendered,
        args,
        });
      } catch (err) {
        // A refusal is a sentence written for the person; it is repeated as
        // written. Anything else is a crash: its message may name a table, a
        // loopback address or a provider's request id, so the person gets a
        // generic sentence and a reference, and the log (already carrying the
        // handler's name, from actions.invoke) carries the reference too.
        if (isActionRefusal(err) && err.message.trim()) {
          res.json({ ok: true, result: { ok: false, error: err.message } });
          return;
        }
        const ref = `act-${randomBytes(3).toString("hex")}`;
        console.error(`[actions] ${parsed.data.actionId} crashed (${ref}):`, err);
        res.json({ ok: true, result: { ok: false, error: crashSentence(ref), ref } });
        return;
      }
      // The way back, when the action knows one: stored by the caller's
      // ledger beside the write, so Undo on the card runs it.
      const undo = await undoFor(parsed.data.actionId, result, {
        orgId: req.tenant!.org.id,
        ...(parsed.data.entityKind && parsed.data.entityId ? { entity: { kind: parsed.data.entityKind, id: parsed.data.entityId } } : {}),
      }).catch(() => null);
      const issued = (undo ?? []).flatMap((u) => ("action_id" in u ? [u] : []));
      if (issued.length) await issueUndos(req.tenant!.org.id, req.session!.id, issued);
      // What the client should refresh, said once here: the record's kind
      // under both its spellings (an instance kind and the module's base
      // kind name the same rows), so every surface showing it can re-read
      // without knowing which action ran. A workspace action names none,
      // and the client refreshes everything.
      const affected = await affectedKindsOf(req.tenant!.org.id, isWorkspaceAction ? null : parsed.data.entityKind ?? null);
      res.json({
        ok: true,
        result,
        ...(undo ? { undo } : {}),
        affected: {
          kinds: affected,
          ...(!isWorkspaceAction && parsed.data.entityKind && parsed.data.entityId
            ? { entity: { kind: parsed.data.entityKind, id: parsed.data.entityId } }
            : {}),
        },
      });
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
    /** A button's own label and what it asks before it runs (binding-ask.ts). */
    label: BindingLabel.nullish(),
    ask: BindingAsk.nullish(),
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
    if ((data.label || data.ask?.length) && data.trigger_type !== "user-invoked") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "label and ask are for a button (trigger_type 'user-invoked'); a wire that fires on its own has nobody to ask",
        path: ["label"],
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

// The workspace actions a wire can run on no record (target "none"): what
// the composer offers for "No record". Record actions come from
// /actions?kind=; these act on the workspace and belong to no kind.
platformOrgRouter.get(
  "/:slug/wire-actions",
  requireAuth,
  withTenant,
  async (_req, res) => {
    res.json({
      items: PLATFORM_ACTIONS.filter((a) => a.recordless).map((a) => ({
        id: a.id,
        label: a.label,
        description: a.description,
        icon: a.icon,
        args_schema: a.args_schema,
      })),
    });
  },
);

/** Every event some module declares it emits (manifest `exposes.events`,
 *  held to having an emitter by lint:manifest-advertises-what-it-has). A wire
 *  on anything else never runs. */
function declaredWireEvents(): Set<string> {
  const out = new Set<string>();
  for (const entry of listEntries()) for (const ev of entry.manifest.exposes?.events ?? []) out.add(ev);
  return out;
}

/** Why a wire on this event would never run, or null when something sends it. */
function silentEventRefusal(triggerType: string | null | undefined, event: string | null | undefined): string | null {
  if (triggerType !== "event" || !event) return null;
  if (declaredWireEvents().has(event)) return null;
  return `Nothing sends "${event}", so a wire on it would never run. Pick an event from the list.`;
}

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
      // A wire that never runs says so on the list rather than looking alive:
      // one stored before the save check existed (never_runs), or one on an
      // event nothing sends any more (trigger_silent).
      const declared = declaredWireEvents();
      const items = [];
      for (const r of rows) {
        items.push({
          ...r,
          never_runs: await lifecycleWireRefusal(req.tenant!.org.id, r.source_kind, r.trigger_type),
          trigger_silent: r.trigger_type === "event" && !!r.trigger_event && !declared.has(r.trigger_event),
        });
      }
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

/** Why a wire on "a record is created / updated / deleted" of this kind could
 *  never run (wire-lifecycle.ts), or null. */
async function lifecycleWireRefusal(orgId: string, sourceKind: string, triggerType: string): Promise<string | null> {
  if (!isLifecycleTrigger(triggerType)) return null;
  const { base, instance } = await platform().entities.resolveKind(orgId, sourceKind);
  return lifecycleRefusal(base, triggerType, !!instance);
}

// Which "a record is created / updated / deleted" triggers a kind can carry,
// and why not when it cannot: the composer offers only the ones that run.
platformOrgRouter.get("/:slug/wire-lifecycle", requireAuth, withTenant, async (req, res, next) => {
  try {
    const kind = typeof req.query.kind === "string" ? req.query.kind : "";
    if (!kind) {
      res.status(400).json({ error: { code: "missing_kind", message: "kind is required" } });
      return;
    }
    const triggers: Record<string, { ok: boolean; why: string | null }> = {};
    for (const t of LIFECYCLE_TRIGGERS) {
      const why = await lifecycleWireRefusal(req.tenant!.org.id, kind, t);
      triggers[t] = { ok: !why, why };
    }
    res.json({ kind, triggers });
  } catch (err) {
    next(err);
  }
});

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
      const silent = silentEventRefusal(parsed.data.trigger_type, parsed.data.trigger_event);
      if (silent) {
        res.status(400).json({ error: { code: "unknown_event", message: silent } });
        return;
      }
      if (parsed.data.filter != null) {
        const { error: ferr } = parseWireFilter(parsed.data.filter);
        if (ferr) {
          res.status(400).json({ error: { code: "invalid_wire_filter", message: ferr } });
          return;
        }
      }
      const dead = await lifecycleWireRefusal(req.tenant!.org.id, parsed.data.source_kind, parsed.data.trigger_type);
      if (dead) {
        res.status(400).json({ error: { code: "wire_never_runs", message: dead } });
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
          label: parsed.data.label ?? null,
          ask: parsed.data.ask?.length ? sql`${JSON.stringify(parsed.data.ask)}::jsonb` : null,
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
        label: BindingLabel.nullish(),
        ask: BindingAsk.nullish(),
      });
      const parsed = Patch.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad patch", details: parsed.error.issues },
        });
        return;
      }
      if (parsed.data.trigger_event) {
        const silent = silentEventRefusal("event", parsed.data.trigger_event);
        if (silent) {
          res.status(400).json({ error: { code: "unknown_event", message: silent } });
          return;
        }
      }
      if (parsed.data.filter != null) {
        const { error: ferr } = parseWireFilter(parsed.data.filter);
        if (ferr) {
          res.status(400).json({ error: { code: "invalid_wire_filter", message: ferr } });
          return;
        }
      }
      if (parsed.data.source_kind !== undefined || parsed.data.trigger_type !== undefined) {
        const before = await meta
          .selectFrom("entity_action_bindings")
          .select(["source_kind", "trigger_type"])
          .where("id", "=", id)
          .where("org_id", "=", req.tenant!.org.id)
          .executeTakeFirst();
        if (before) {
          const dead = await lifecycleWireRefusal(req.tenant!.org.id, parsed.data.source_kind ?? before.source_kind, parsed.data.trigger_type ?? before.trigger_type);
          if (dead) {
            res.status(400).json({ error: { code: "wire_never_runs", message: dead } });
            return;
          }
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
      if (d.label !== undefined) setObj.label = d.label ?? null;
      if (d.ask !== undefined) setObj.ask = d.ask?.length ? sql`${JSON.stringify(d.ask)}::jsonb` : null;
      // The wire as it was: the log says what this edit changed (#4517).
      const wasWire = await meta.selectFrom("entity_action_bindings").selectAll().where("id", "=", id).where("org_id", "=", req.tenant!.org.id).executeTakeFirst();
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
        before: wasWire,
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

platformOrgRouter.get("/:slug/bulk-field-options", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const kinds = typeof req.query.kinds === "string" ? req.query.kinds.split(",").filter(Boolean) : [];
    res.json({ items: await commonBulkFields(req.tenant!.org.id, kinds) });
  } catch (err) { next(err); }
});

// ──────────────────────── field defs (Pillar D-lite) ───────────────
//
// FieldDefCreate + FieldRenderer + the create body live in
// platform/field-defs.ts (createFieldDef) — shared with the
// platform:add-field action handler so the trait-scope, relation and
// reserved-name rules cannot fork between the two surfaces.


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
      // A shipped field's "remember new entries" is the workspace's own once
      // switched, kept in the override layer (updateFieldDef routes it there),
      // and the field's settings page reads it here. Its choices stay the
      // shipped list on this read: the config surfaces manage the raw defs, and
      // the effective read carries the workspace's list.
      // Whether a field is private is a person's own mark on ANY field, kept
      // there too, so the layer is read for every field.
      const ownBlob = new Map(
        (
          await meta
            .selectFrom("native_field_overrides")
            .select(["entity_kind", "name", "overrides"])
            .where("org_id", "=", req.tenant!.org.id)
            .execute()
        ).map((o) => [`${o.entity_kind} ${o.name}`, o.overrides] as const),
      );
      const items = rawItems.map((f) => {
        const blob = ownBlob.get(`${f.entity_kind} ${f.name}`);
        const own = f.bundle_id ? blob : undefined;
        return {
          ...f,
          ...(own?.learns !== undefined ? { learns: own.learns } : {}),
          private: blob?.private === true,
          bundle_external_id: f.bundle_id ? (bundleById.get(f.bundle_id)?.external_id ?? null) : null,
          bundle_name: f.bundle_id ? (bundleById.get(f.bundle_id)?.name ?? null) : null,
        };
      });
      // The form-builder sections a kind's fields are filed under travel with
      // every read of that kind: a reader that gets section_id without the
      // sections cannot place (or, worse, shows none of) those fields.
      const sectionsOf = async () =>
        kind
          ? meta.selectFrom("field_sections").select(["id", "name", "position"]).where("org_id", "=", req.tenant!.org.id).where("entity_kind", "=", kind).orderBy("position").orderBy("name").execute()
          : [];
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
          sections: await sectionsOf(),
          // The kind's own columns that carry a meaning (Bought from is the
          // seller on a vehicle): a record's form reads them so a meaning a
          // column already answers is not offered again as a note.
          ...(kind ? { native_roles: (await kindFieldsWithMeaning(req.tenant!.org.id, kind)).filter((f) => f.source === "built-in").map((f) => ({ name: f.name, label: f.label, field_role: f.field_role })) } : {}),
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
            learns: o.overrides?.learns ?? f.learns,
            private: o.overrides?.private === true,
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
// AI-ACTION: platform:group-fields
platformOrgRouter.post("/:slug/field-sections", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "platform:group-fields"))) return;
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
// AI-ACTION: platform:group-fields
platformOrgRouter.patch("/:slug/field-sections/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "platform:group-fields"))) return;
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

// AI-ACTION: platform:ungroup-fields
platformOrgRouter.delete("/:slug/field-sections/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "platform:ungroup-fields"))) return;
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
// AI-ACTION: platform:group-fields
platformOrgRouter.post("/:slug/field-defs/reorder", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "platform:group-fields"))) return;
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
      // Identification is a SEPARATE axis from "is a chat provider connected".
      // A deployment can identify a photo or a barcode through the hosted
      // service with no provider configured at all, which is exactly the try
      // sandbox - and it was telling every visitor that scanning ran in basic
      // mode while cheerfully naming their groceries from a photo. The UI needs
      // both facts to say anything true.
      //
      // And the other way round: with the hosted service off, a person whose
      // own connection can read a photo was told "No AI to read this photo
      // yet (set it up)" under every card (the 2026-09-13 review, #2845). The
      // axis is "can THIS person's photo be read here", which the hosted
      // service answers, or a provider with the image capability routed to
      // them: their own connection, the workspace's, or the plan's.
      //
      // "The hosted service is on" is not "it serves THIS workspace": a
      // deployment can scope it to some workspaces (#3867). The reach is the
      // same function the scan asks before every call. Outside the scope, the
      // person's own AI is still a way in, and the reason says so.
      const hosted = await hostedIdentifyReach(req.tenant!.org.id);
      const identify = hosted.available
        ? { available: true, source: "hosted" as const }
        : await checkAiAvailability(req.tenant!.org.id, req.session?.id ?? null, "classify-image").then(
            (r) => ({ available: r.available, source: r.available ? r.source : undefined }),
            () => ({ available: false, source: undefined }),
          );
      const identifyReason = !identify.available && !hosted.available && hosted.why === "scope" ? "hosted_scope" : undefined;
      // A third axis: can this deployment read the TEXT off an image with no
      // model at all (the OCR engine behind the receipt-shape check and the
      // receipt door's line tier)? Reported so "the receipt went to the
      // model" is a fact a person can read off the deployment rather than
      // infer from what happened.
      res.json({
        ...status,
        identify_available: identify.available,
        identify_source: identify.source,
        ...(identifyReason ? { identify_reason: identifyReason } : {}),
        ocr_available: await ocrAvailable(),
      });
    } catch (err) {
      next(err);
    }
  },
);

// A workspace's say over each service capability (services.md section 9):
// always ask, run, or off; no row is the default (the capability's effect
// decides). Member-readable, so the confirm card can say why it asks.
platformOrgRouter.get("/:slug/services/policies", requireAuth, withTenant, async (req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("service_capability_policies")
      .select(["capability", "policy", "updated_at"])
      .where("org_id", "=", req.tenant!.org.id)
      .orderBy("capability")
      .execute();
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

const ServicePolicyBody = z.object({ policy: z.enum(["default", "always_ask", "run", "off"]) }).strict();

// AI-REACH: exempt — what an assistant may run without asking is a person's to set, never the assistant's own.
platformOrgRouter.put("/:slug/services/policies/:capability", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const capability = String(req.params.capability ?? "");
    // Service capability ids always carry a dot; AI capabilities never do.
    if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(capability)) {
      res.status(400).json({ error: { code: "invalid_capability", message: "A service capability looks like slice.model." } });
      return;
    }
    const parsed = ServicePolicyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "policy must be default, always_ask, run or off" } });
      return;
    }
    const orgId = req.tenant!.org.id;
    if (parsed.data.policy === "default") {
      await meta.deleteFrom("service_capability_policies").where("org_id", "=", orgId).where("capability", "=", capability).execute();
    } else {
      const policy = parsed.data.policy;
      await meta
        .insertInto("service_capability_policies")
        .values({ org_id: orgId, capability, policy, updated_by: req.session!.id })
        .onConflict((oc) => oc.columns(["org_id", "capability"]).doUpdateSet({ policy, updated_by: req.session!.id, updated_at: new Date() }))
        .execute();
    }
    res.json({ capability, policy: parsed.data.policy });
  } catch (err) {
    next(err);
  }
});

// Who answers an AI call here, in the order they are asked (#3842): for the
// person asking, and for automations (no person at the keyboard, so only
// connections shared with the workspace). Member-readable. A connection that
// belongs to somebody else shows as theirs and no more: its label and
// provider stay private, as they do everywhere a Share is shown.
platformOrgRouter.get("/:slug/ai-chain", requireAuth, withTenant, async (req, res, next) => {
  try {
    const q = typeof req.query.capability === "string" ? req.query.capability : "chat";
    if (!(AiCapabilities as readonly string[]).includes(q)) {
      res.status(400).json({ error: { code: "invalid_capability", message: `capability must be one of: ${AiCapabilities.join(", ")}` } });
      return;
    }
    const capability = q as AiCapability;
    const orgId = req.tenant!.org.id;
    const me = req.session?.id ?? null;
    const [mine, automations] = await Promise.all([aiChainFor(orgId, me, capability), aiChainFor(orgId, null, capability)]);
    const credIds = [...new Set([...mine.steps, ...automations.steps].map((s) => s.credential_id).filter((x): x is string => !!x))];
    const creds = credIds.length
      ? await meta.selectFrom("user_credentials").select(["id", "verification"]).where("id", "in", credIds).execute()
      : [];
    const ownerIds = [...new Set([...mine.steps, ...automations.steps].map((s) => s.owner_user_id).filter((x): x is string => !!x))];
    const owners = ownerIds.length ? await meta.selectFrom("users").select(["id", "display_name"]).where("id", "in", ownerIds).execute() : [];
    const rowIds = [...new Set([...mine.steps, ...automations.steps].map((s) => s.provider_row_id).filter((x): x is string => !!x))];
    let rows: Array<{ id: string; verification: unknown }> = [];
    if (rowIds.length) {
      try {
        const tdb = (await getTenantDb(orgId)) as unknown as {
          selectFrom: (t: string) => { select: (c: string[]) => { where: (a: string, o: string, v: unknown) => { execute: () => Promise<Array<{ id: string; verification: unknown }>> } } };
        };
        rows = await tdb.selectFrom("core_ai_providers").select(["id", "verification"]).where("id", "in", rowIds).execute();
      } catch {
        rows = [];
      }
    }
    const shown = (s: AiChainStep) => {
      const v = verificationFrom(s.credential_id ? creds.find((c) => c.id === s.credential_id)?.verification : rows.find((r) => r.id === s.provider_row_id)?.verification);
      const def = getAiProvider(s.provider_id);
      const vision = !!def?.capabilities["identify-image"];
      const common = {
        position: s.position,
        asked: s.asked,
        source: s.source,
        status: v ? verificationLabel(v) : null,
        verified: v?.state === "verified",
        // "declared": takes images and is not in doubt. null: in doubt and
        // not yet shown the test picture.
        reads_photos: !vision ? ("no" as const) : (v?.photos ?? (def?.checksPhotosInTest ? null : ("declared" as const))),
        ...(s.your_default ? { your_default: true as const } : {}),
      };
      if (s.source === "shared" && s.owner_user_id !== me) {
        const owner = owners.find((o) => o.id === s.owner_user_id)?.display_name ?? "a member";
        return { ...common, label: `Shared by ${owner}` };
      }
      return {
        ...common,
        label: s.label,
        provider_id: s.provider_id,
        model: s.model,
        ...(s.model_label ? { model_label: s.model_label } : {}),
        floating: s.floating,
        ...(s.credential_id ? { credential_id: s.credential_id } : {}),
      };
    };
    res.json({
      capability,
      you: { steps: mine.steps.map(shown), ...(mine.refusal ? { refusal: mine.refusal } : {}) },
      automations: { steps: automations.steps.map(shown), ...(automations.refusal ? { refusal: automations.refusal } : {}) },
    });
  } catch (err) {
    next(err);
  }
});

// Per-workspace AI opt-out setting. GET is member-readable (drives the toggle +
// honest banner); the write is owner/admin. Turning it off disables the
// workspace/managed AI default here — a user's own personal connection still works.
platformOrgRouter.get("/:slug/ai-settings", requireAuth, withTenant, async (req, res, next) => {
  try {
    const row = await meta.selectFrom("orgs").select("ai_disabled").where("id", "=", req.tenant!.org.id).executeTakeFirst();
    res.json({ ai_disabled: !!row?.ai_disabled });
  } catch (err) {
    next(err);
  }
});
// AI-REACH: exempt — a workspace configuration toggle, not a Cobb action (a
// person flips it in settings; Cobb never turns its own AI off).
platformOrgRouter.patch("/:slug/ai-settings", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const disabled = !!(req.body as { ai_disabled?: unknown })?.ai_disabled;
    await meta.updateTable("orgs").set({ ai_disabled: disabled }).where("id", "=", req.tenant!.org.id).execute();
    res.json({ ai_disabled: disabled });
  } catch (err) {
    next(err);
  }
});

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

// AI-ACTION: platform:edit-field
platformOrgRouter.put(
  "/:slug/native-field-overrides",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!(await requireCapability(req, res, "platform:edit-field"))) return;
      const parsed = NativeFieldOverrideBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "Bad override", details: parsed.error.issues } });
        return;
      }
      const d = parsed.data;
      const row = await upsertNativeFieldOverride(req.tenant!.org.id, d.entity_kind, d.name, {
        displayLabel: d.display_label,
        hidden: d.hidden,
        position: d.position,
        choices: d.choices,
      });
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);

// AI-REACH: wiping every workspace override on one field at once — its label,
// whether it shows, its choices. Changing any of those is platform:edit-field;
// this is the settings screen's reset button, which should stay a person's.
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

// ── Field presets ────────────────────────────────────────────────────────────
// A named set of role-tagged fields you switch on, rather than install. The
// switch has to be idempotent: creating a field that already exists is how a
// setting quietly produces duplicates. See docs/design-decisions/field-presets.md.

platformOrgRouter.get(
  "/:slug/field-presets",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const orgId = req.tenant!.org.id;
      const items = await Promise.all(
        FIELD_PRESETS.map(async (p) => presetState(p, await presetFieldStates(orgId, p))),
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

// AI-ACTION: platform:set-field-preset
platformOrgRouter.post(
  "/:slug/field-presets/:key",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!(await requireCapability(req, res, "platform:set-field-preset"))) return;
      const result = await turnPresetOn(req.tenant!.org.id, req.params.key ?? "");
      if (!result.ok) {
        res.status(404).json({ error: { code: result.code, message: result.message } });
        return;
      }
      res.status(201).json({
        ...result.state,
        created: result.created ?? [],
        ...(result.failed?.length ? { failed: result.failed } : {}),
      });
    } catch (err) {
      next(err);
    }
  },
);

// AI-ACTION: platform:set-field-preset
platformOrgRouter.delete(
  "/:slug/field-presets/:key",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!(await requireCapability(req, res, "platform:set-field-preset"))) return;
      const result = await turnPresetOff(req.tenant!.org.id, req.params.key ?? "");
      if (!result.ok) {
        res.status(404).json({ error: { code: result.code, message: result.message } });
        return;
      }
      // Values already recorded stay on the items and come back if the preset is
      // switched on again. Said out loud so the switch does not read as destructive.
      res.json({ ...result.state, removed: result.removed ?? [], values_kept: true });
    } catch (err) {
      next(err);
    }
  },
);

// What a field about to be made would mean, read from its label, and the
// field this kind already has with that meaning: the Fields form asks this
// while the label is typed ("Looks like where it came from: right?", "This
// kind already has Bought from"). A read, as the person asking.
// AI-REACH: reads
platformOrgRouter.get(
  "/:slug/field-defs/meaning",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : "";
      const label = typeof req.query.label === "string" ? req.query.label : "";
      const name = typeof req.query.name === "string" ? req.query.name : "";
      const roleAsked = typeof req.query.role === "string" && req.query.role ? req.query.role : null;
      const role = roleAsked ?? meaningFromWords(label, name);
      const pickable = role ? (FIELD_ROLE_LABELS as Record<string, { label: string; pickable: boolean }>)[role] : undefined;
      if (!role || !pickable?.pickable) {
        res.json({ role: null, role_label: null, same_as: null });
        return;
      }
      const same = kind && !kind.startsWith("@") ? fieldWithMeaning(await kindFieldsWithMeaning(req.tenant!.org.id, kind), role, name || null) : null;
      res.json({ role, role_label: pickable.label, read_from_label: !roleAsked, same_as: same ? { name: same.name, label: same.label, source: same.source } : null });
    } catch (err) {
      next(err);
    }
  },
);

// Whether a kind's sellers, noted beside where things came from, have earned
// a field of their own (seller-upgrade.ts). Read wherever a person is working
// with that field; the first time it is due for this workspace and kind, the
// person is told once. Answered through platform:track-sellers / decline.
// AI-REACH: reads
platformOrgRouter.get(
  "/:slug/field-defs/seller-offer",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : "";
      if (!kind) {
        res.status(400).json({ error: { code: "invalid_query", message: "kind is required" } });
        return;
      }
      const orgId = req.tenant!.org.id;
      const offer = await sellerOffer(orgId, kind, { userId: req.session?.id, role: req.tenant!.role });
      if (offer && !offer.state && roleSatisfies(req.tenant!.role, ["owner", "admin"])) await offerOnce(orgId, offer, req.session?.id ?? null);
      res.json({ offer: offer && offer.state !== "declined" && offer.state !== "accepted" ? offer : null });
    } catch (err) {
      next(err);
    }
  },
);

// The kinds that hold two fields meaning one thing, to settle once: the
// Fields page shows each as one notice (Use this one / Keep that one), and the
// assistant reads the same list. Never merged on its own.
// AI-REACH: reads
platformOrgRouter.get(
  "/:slug/field-defs/same-meaning",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const orgId = req.tenant!.org.id;
      const only = typeof req.query.kind === "string" && req.query.kind ? [req.query.kind] : (await platform().entities.listKindsForOrg(orgId)).map((k) => k.id);
      const items: Array<{ entity_kind: string; role: string; role_label: string; fields: Array<{ name: string; label: string; source: string }> }> = [];
      for (const kind of only) {
        for (const g of sameMeaningGroups(await kindFieldsWithMeaning(orgId, kind))) {
          items.push({
            entity_kind: kind,
            role: g.role,
            role_label: (FIELD_ROLE_LABELS as Record<string, { label: string }>)[g.role]?.label ?? g.role,
            fields: g.fields.map((f) => ({ name: f.name, label: f.label, source: f.source })),
          });
        }
      }
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

// AI-ACTION: platform:add-field
platformOrgRouter.post(
  "/:slug/field-defs",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // Defining fields is workspace configuration: the same bar as the
      // Configuration screen that edits them (owner or admin), like every
      // sibling write here (#2982).
      if (!(await requireCapability(req, res, "platform:add-field"))) return;
      const parsed = FieldDefCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad field def", details: parsed.error.issues },
        });
        return;
      }
      const result = await createFieldDef(req.tenant!.org.id, parsed.data);
      if (!result.ok) {
        // duplicate_name is a conflict, not a bad request — a retry with the
        // same body will conflict again for a different reason than malformed.
        // same_meaning carries the field to use instead, so the form can offer
        // it ("Use Bought from") rather than only say no.
        res.status(result.code === "duplicate_name" || result.code === "same_meaning" ? 409 : 400).json({
          error: {
            code: result.code,
            message: result.message,
            ...(result.code === "same_meaning" ? { existing: result.existing, role: result.role, inferred: result.inferred } : {}),
          },
        });
        return;
      }
      // `warning` rides beside the row: a per-kind field shadowing a scoped
      // one is legitimate, but must not be silent (see createFieldDef).
      res.status(201).json({ ...result.def, ...(result.warning ? { warning: result.warning } : {}) });
    } catch (err) {
      next(err);
    }
  },
);

// AI-ACTION: platform:edit-field
// GATE: two bars on one route (#2982), a member may grow a dropdown's choices and the rest needs the admin tier; one runBy cannot say both. Through Cobb a member is refused even the choices (#5170 lists it).
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
      // Two bars on one route (#2982). Growing a dropdown's CHOICES is a
      // member's write (the scan confirm's category growth goes through it; a
      // value typed into a picker is learned by platform:learn-choice, the
      // same bar). Changing the field's STRUCTURE (label, type, role, required) is
      // configuration: owner or admin, the bar of the screen that edits it
      // and of every sibling write here. This route used to check only that
      // the caller was signed in.
      const choicesOnly = Object.keys(parsed.data).every((k) => k === "choices");
      if (!(choicesOnly ? requireRole(req, res, "owner", "admin", "member") : requireRole(req, res, "owner", "admin"))) return;
      const result = await updateFieldDef(req.tenant!.org.id, id, parsed.data);
      if (!result.ok) {
        res.status(result.code === "not_found" ? 404 : 400).json({
          error: { code: result.code, message: result.message },
        });
        return;
      }
      // Surface the EFFECTIVE choices so the caller immediately sees its override.
      res.json(
        result.effectiveChoices !== undefined
          ? { ...result.def, choices: result.effectiveChoices }
          : result.def,
      );
    } catch (err) {
      next(err);
    }
  },
);

// What a field already holds across a kind's records, for the choice picker:
// each value with how many records hold it and when one last took it, and
// (detail / note) what rides beside each one. A read, as the person asking.
// AI-REACH: reads
platformOrgRouter.get(
  "/:slug/field-values",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : "";
      const field = typeof req.query.field === "string" ? req.query.field : "";
      if (!kind || !field) {
        res.status(400).json({ error: { code: "missing_params", message: "kind and field are required" } });
        return;
      }
      const detail = typeof req.query.detail === "string" && req.query.detail ? req.query.detail : null;
      const out = await fieldValuesUsed(req.tenant!.org.id, kind, field, {
        detail,
        withNote: req.query.note === "1",
        viewer: { userId: req.session?.id, role: req.tenant!.role },
      });
      res.json(out);
    } catch (err) {
      next(err);
    }
  },
);

// The addresses this workspace already used, for the address picker, matched
// against what is being typed ("mvc" finds MVC Lodi Agency), each with the
// record it was last used on. `lookup` names the map lookup when one is set,
// and is null when none is, so the picker offers no map search it cannot run;
// a slow or failed lookup answers with the workspace's own places and says so.
// A read, as the person asking (#5317).
// AI-REACH: reads
platformOrgRouter.get(
  "/:slug/addresses",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
      const used = await addressesUsed(req.tenant!.org.id, {
        query: q,
        viewer: { userId: req.session?.id, role: req.tenant!.role },
      });
      const lookup = addressLookup();
      let found: AddressValue[] = [];
      let lookupFailed = false;
      if (lookup && q.trim().length >= LOOKUP_MIN_CHARS) {
        try {
          found = await lookup.suggest(q.trim(), { near: nearestBias(used), signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
        } catch (err) {
          lookupFailed = true;
          console.warn(`[addresses] lookup ${lookup.name} failed:`, (err as Error).message);
        }
      }
      res.json({
        used,
        found,
        lookup: lookup ? { name: lookup.name } : null,
        ...(lookupFailed ? { lookup_failed: true } : {}),
      });
    } catch (err) {
      next(err);
    }
  },
);

// What changing a field's type would do to the values it holds, asked
// before the change. A read, and configuration's: the same bar as the change.
platformOrgRouter.get(
  "/:slug/field-defs/:id/retype-preview",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const to = typeof req.query.to === "string" ? req.query.to : "";
      const out = await previewRetype(req.tenant!.org.id, req.params.id!, to);
      if ("error" in out) {
        res.status(out.error === "not_found" ? 404 : 400).json({ error: { code: out.error, message: out.message } });
        return;
      }
      res.json(out);
    } catch (err) {
      next(err);
    }
  },
);

// AI-ACTION: platform:remove-field
platformOrgRouter.delete(
  "/:slug/field-defs/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // Defining fields is workspace configuration: the same bar as the
      // Configuration screen that edits them (owner or admin), like every
      // sibling write here (#2982).
      if (!(await requireCapability(req, res, "platform:remove-field"))) return;
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const result = await deleteFieldDef(req.tenant!.org.id, id);
      if (!result.ok) {
        res.status(404).json({ error: { code: result.code, message: result.message } });
        return;
      }
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
      // Only the actions of modules this workspace has turned on: a module
      // that is off is off for its actions too, the way its routes already
      // are (#3255). Every reader the assistant has comes through here, so
      // this is what keeps it from offering a card that cannot run.
      const on = await enabledActionOwners(orgId);
      res.json({
        // An action that exists only as the way back for another is not listed
        // for anyone who did not ask: every reader the assistant has (the tool,
        // the prompt rail, the argument schemas) comes through here.
        items: actions.filter((a) => on.has(a.module_name) && (a.internal !== true || req.query.include_internal === "1")).map((a) => {
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
            // The action's ARGUMENTS. Without these an action is listed and not
            // callable: the assistant can see that core-locations:reorder
            // exists and has no machine-readable way to learn it takes `ids`,
            // so it reports that it cannot run it (2026-08-19). registry-sync
            // has stored this all along; the response simply never carried it.
            args_schema: a.args_schema ?? null,
            // Whether a mistaken run can be put right here. A caller that
            // cannot show a confirmation reads this to know what it may run.
            undoable: a.undoable === true,
            effect: a.effect ?? null,
            internal: a.internal === true,
            // The BUTTON flag: false means no button on the record's page,
            // and says nothing about the assistant (placing, tagging and
            // stock adjustments are all false here and all Cobb's).
            user_invokable: a.user_invokable !== false,
            // Fired by an event and nothing else, its record named by the
            // event: the assistant's readers leave it out (offerableToAssistant).
            wire_only: a.wire_only === true,
            record_optional: a.record_optional === true,
            // Whether a run of it can be put back from the card: the handler
            // registered how. Distinct from `undoable`, which is whether an
            // AI may run it unconfirmed; a guard holds the second to imply
            // the first for every declared action.
            has_inverse: !!a.invoke_handler && hasUndo(a.invoke_handler),
            examples: (a.examples as string[] | null) ?? [],
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
        actions: actions.filter((a) => a.internal !== true || req.query.include_internal === "1").map((a) => {
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
            args_schema: a.args_schema ?? null,
            undoable: a.undoable === true,
            internal: a.internal === true,
            // The BUTTON flag: false means no button on the record's page,
            // and says nothing about the assistant (placing, tagging and
            // stock adjustments are all false here and all Cobb's).
            user_invokable: a.user_invokable !== false,
            // Fired by an event and nothing else, its record named by the
            // event: the assistant's readers leave it out (offerableToAssistant).
            wire_only: a.wire_only === true,
            record_optional: a.record_optional === true,
            // Whether a run of it can be put back from the card: the handler
            // registered how. Distinct from `undoable`, which is whether an
            // AI may run it unconfirmed; a guard holds the second to imply
            // the first for every declared action.
            has_inverse: !!a.invoke_handler && hasUndo(a.invoke_handler),
            examples: (a.examples as string[] | null) ?? [],
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
      requires: z.object({ traits: z.array(z.string()).min(1) }).optional(),
    })
    .refine(
      (d) => d.kinds || d.traits || d.hasFieldRole,
      "must specify at least one of kinds, traits, or hasFieldRole",
    ),
]);

// AI-REACH: which records an ACTION appears on, which is the assistant's own
// reach. Letting it widen where its actions apply is letting it change what it
// is allowed to touch, and that belongs to a person on a screen that shows the
// blast radius.
platformOrgRouter.put(
  "/:slug/registered-actions/:id/predicate",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // Where an action appears is configuration: it widens or narrows what
      // every person in the workspace is offered.
      if (!requireRole(req, res, "owner", "admin")) return;
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

// AI-REACH: the same reach, put back to the manifest default. Also a person's.
platformOrgRouter.delete(
  "/:slug/registered-actions/:id/predicate",
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
      const orgId = req.tenant!.org.id;
      const action = await meta.selectFrom("entity_actions").select("id").where("id", "=", id).executeTakeFirst();
      if (!action) {
        res.status(404).json({ error: { code: "not_found", message: "action not found" } });
        return;
      }
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
