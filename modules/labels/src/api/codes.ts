// /codes — read/assign human-readable label codes, resolve a typed code back to
// its entity, and manage per-kind grain + prefixes. See
// docs/design-decisions/label-codes.md and ../services/codes.ts.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import {
  assignCodes,
  getCodes,
  resolveCode,
  normalizePrefix,
  prefixTakenByOther,
  groupValueOf,
  derivePrefix,
  declaredOverlayDefault,
  getOverlayCenter,
  renameCodeGroup,
  setCodeConfig,
  setGroupOverlay,
} from "../services/codes.js";
import { labelableKindForModule, type LabelableKind } from "./browse.js";

export const codesRouter = Router({ mergeParams: true });

// Reads (resolve/list/config/groups) are open to guests; mutations need member+.
codesRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

// GET /resolve?q=m1 — tolerant of look-alike typos + case. 404 if no match.
codesRouter.get(
  "/resolve",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: { code: "missing_q", message: "q required" } });
      return;
    }
    const hit = await resolveCode(tenantDb(req), q);
    if (!hit) {
      res.status(404).json({ error: { code: "not_found", message: "no entity has that code" } });
      return;
    }
    // Enrich with the entity's title + deep link so the caller can jump to it.
    const ctx = tenantContext(req);
    const ent = await platform().entities.lookup(ctx.org.id, hit.entity_kind, hit.entity_id).catch(() => null);
    res.json({ ...hit, title: ent?.title ?? null, detail_url: ent?.detailUrl ?? null });
  }),
);

// GET /?entity_ids=a,b,c — existing codes only, no minting. { codes: {id:code} }
codesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ids = String(req.query.entity_ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const map = await getCodes(tenantDb(req), ids);
    res.json({ codes: Object.fromEntries(map) });
  }),
);

// POST /assign { refs:[{kind,id}] } — get-or-assign. { codes: {id:code} }
const AssignBody = z.object({
  refs: z
    .array(z.object({ kind: z.string().min(1).max(120), id: z.string().min(1).max(120) }))
    .min(1)
    .max(500),
});
// AI-REACH: exempt — internal code minting (get-or-assign). Runs inside the
// label/print flow to reserve a code; not a user-facing operation.
codesRouter.post(
  "/assign",
  asyncHandler(async (req, res) => {
    const parsed = AssignBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const map = await assignCodes(ctx.org.id, tenantDb(req), parsed.data.refs);
    res.json({ codes: Object.fromEntries(map) });
  }),
);

// GET /config?kind=machines:machine — the per-kind grain (default 'instance')
// and whether to draw the code in the QR center (default true).
codesRouter.get(
  "/config",
  asyncHandler(async (req, res) => {
    const kind = String(req.query.kind ?? "").trim();
    if (!kind) {
      res.status(400).json({ error: { code: "missing_kind", message: "kind required" } });
      return;
    }
    const row = await tenantDb(req)
      .selectFrom("labels_code_config")
      .select(["entity_kind", "group_field", "overlay_center"])
      .where("entity_kind", "=", kind)
      .executeTakeFirst();
    // No saved toggle => the kind's module-declared default (registry seam),
    // so the UI shows the same initial state the printer will use.
    res.json({
      entity_kind: kind,
      group_field: row?.group_field ?? "instance",
      overlay_center: row?.overlay_center ?? (await declaredOverlayDefault(kind)),
    });
  }),
);

// PATCH /config { kind, group_field?, overlay_center? } — change the grain
// and/or the QR-center toggle for a kind. At least one of the two must be
// present. Only new codes follow a new grouping; already-assigned codes are
// frozen. The overlay toggle takes effect on the next print/preview.
const ConfigBody = z
  .object({
    kind: z.string().min(1).max(120),
    group_field: z.string().min(1).max(80).optional(),
    overlay_center: z.boolean().optional(),
  })
  .refine((b) => b.group_field !== undefined || b.overlay_center !== undefined, {
    message: "group_field or overlay_center required",
  });
// AI-REACH: action labels:set-code — grain + QR-center toggle (shared service
// setCodeConfig in services/codes.ts).
codesRouter.patch(
  "/config",
  asyncHandler(async (req, res) => {
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { kind, group_field, overlay_center } = parsed.data;
    // Shared with the labels:set-code workspace action (services/codes.ts) so
    // the HTTP surface and the AI surface can't drift on the seed-default rule.
    const result = await setCodeConfig(tenantDb(req), kind, { group_field, overlay_center });
    res.json(result);
  }),
);

// GET /groups — every code group with its prefix + count, for the management UI.
codesRouter.get(
  "/groups",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("labels_code_prefixes")
      .select(["group_key", "entity_kind", "prefix", "label", "next_seq", "frozen", "overlay_center"])
      .orderBy("entity_kind")
      .orderBy("prefix")
      .execute();
    // Resolve friendly display names so the panel shows "Machines" / "3D Printers"
    // rather than the raw kind id (machines:machine) or an instance slug. The
    // registry carries a display_name per kind AND per named instance
    // (<instance_name>:item records), so one listing covers both.
    const kinds = await platform().entities.listKindsForOrg(ctx.org.id).catch(() => []);
    const kindLabel = new Map(kinds.map((k) => [k.id, k.display_name]));
    const instanceLabel = new Map(
      kinds.filter((k) => k.instance_name).map((k) => [k.instance_name!, k.display_name]),
    );
    const labelFor = (entity_kind: string, groupField: string, groupValue: string, kind_label: string) =>
      // The group's own display name: a value that fell back to the kind (no
      // instance / field value) uses the kind's name; an instance value resolves
      // to that instance's name; any other field value (e.g. a category) shows as
      // the user stored it.
      !groupValue || groupValue === entity_kind
        ? kind_label
        : groupField === "instance"
          ? instanceLabel.get(groupValue) ?? groupValue
          : groupValue;

    // ── SUGGESTED groups ─────────────────────────────────────────────────────
    // Every labelable list the workspace has that hasn't minted a code YET, shown
    // up front with a derived prefix the user can keep, change, or clear before
    // anything prints — instead of a list only appearing after its first label.
    // The group_key is built with groupValueOf's exact scheme, so committing a
    // suggestion (or the first mint) lands on the same row. Only instance-grouped
    // kinds can be enumerated ahead of data; a kind grouped by a custom field has
    // emergent groups and keeps the lazy behaviour.
    const committedKeys = new Set(rows.map((r) => r.group_key));
    const taken = new Set(rows.map((r) => r.prefix).filter((p): p is string => !!p));
    const cfg = await db.selectFrom("labels_code_config").select(["entity_kind", "group_field"]).execute();
    const groupFieldFor = new Map(cfg.map((c) => [c.entity_kind, c.group_field]));
    const instances = await platform().instances.list(ctx.org.id).catch(() => []);
    const modulesWithNamed = new Set(instances.filter((i) => !i.is_default).map((i) => i.module_name));
    const lkCache = new Map<string, LabelableKind | null>();
    const lkFor = async (m: string) => {
      if (!lkCache.has(m)) lkCache.set(m, await labelableKindForModule(m, ctx.org.id).catch(() => null));
      return lkCache.get(m) ?? null;
    };
    const suggestions: Array<{ group_key: string; entity_kind: string; prefix: string; group_label: string }> = [];
    for (const inst of instances) {
      if (inst.is_default && modulesWithNamed.has(inst.module_name)) continue; // superseded default
      const lk = await lkFor(inst.module_name);
      if (!lk) continue; // module owns nothing labelable
      if ((groupFieldFor.get(lk.kind) ?? "instance") !== "instance") continue; // emergent groups
      // Build the key exactly as a real mint would (groupValueOf): a default
      // instance keys on the kind, a named one on its instance_name.
      const { key } = groupValueOf(lk.kind, "instance", { instance: inst.is_default ? "" : inst.instance_name });
      if (committedKeys.has(key)) continue;
      const group_label = inst.is_default ? kindLabel.get(lk.kind) ?? lk.label : instanceLabel.get(inst.instance_name) ?? inst.display_name;
      const prefix = derivePrefix(group_label, taken);
      taken.add(prefix);
      suggestions.push({ group_key: key, entity_kind: lk.kind, prefix, group_label });
    }

    // Effective QR-center default resolved for committed AND suggested kinds.
    const allKinds = [...new Set([...rows.map((r) => r.entity_kind), ...suggestions.map((s) => s.entity_kind)])];
    const kindOverlay = await getOverlayCenter(db, allKinds);

    const committed = rows.map((r) => {
      const parts = r.group_key.split("|");
      const kind_label = kindLabel.get(r.entity_kind) ?? r.entity_kind;
      return {
        ...r,
        count: Number(r.next_seq) - 1,
        kind_label,
        group_label: labelFor(r.entity_kind, parts[1] ?? "", parts[2] ?? "", kind_label),
        overlay_center: r.overlay_center ?? kindOverlay.get(r.entity_kind) ?? true,
        suggested: false,
      };
    });
    const suggested = suggestions.map((s) => ({
      group_key: s.group_key,
      entity_kind: s.entity_kind,
      prefix: s.prefix,
      label: s.group_label,
      next_seq: 1,
      frozen: false,
      overlay_center: kindOverlay.get(s.entity_kind) ?? true,
      count: 0,
      kind_label: kindLabel.get(s.entity_kind) ?? s.entity_kind,
      group_label: s.group_label,
      suggested: true,
    }));

    res.json({ groups: [...committed, ...suggested] });
  }),
);

// POST /groups { entity_kind, group_field, group_value, prefix } — pre-seed a
// group's prefix BEFORE any label is printed, so the user picks a memorable one
// up front. Rejected once the group has printed codes (frozen).
const SeedBody = z.object({
  entity_kind: z.string().min(1).max(120),
  group_field: z.string().min(1).max(80).default("instance"),
  group_value: z.string().min(1).max(200),
  // Empty = opt this list out of a code entirely (a null-prefix row), so a
  // suggested code can be disabled before it ever prints.
  prefix: z.string().max(8),
});
// AI-REACH: exempt — pre-seed a memorable prefix BEFORE a group's first print.
// Once codes exist the AI renames via the labels:set-code action; seeding a
// brand-new group by voice is a BACKLOG follow-up.
codesRouter.post(
  "/groups",
  asyncHandler(async (req, res) => {
    const parsed = SeedBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    // A blank prefix opts the list out of a code (null-prefix row); otherwise
    // normalize + collision-check the chosen one.
    const rawPrefix = parsed.data.prefix.trim();
    let prefix: string | null = null;
    if (rawPrefix !== "") {
      try {
        prefix = normalizePrefix(rawPrefix);
      } catch (e) {
        res.status(400).json({ error: { code: "bad_prefix", message: (e as Error).message } });
        return;
      }
    }
    const db = tenantDb(req);
    // Match groupValueOf's key exactly so a later mint lands on this row.
    const { key, label } = groupValueOf(parsed.data.entity_kind, parsed.data.group_field, {
      [parsed.data.group_field]: parsed.data.group_value,
    });
    const existing = await db
      .selectFrom("labels_code_prefixes")
      .selectAll()
      .where("group_key", "=", key)
      .executeTakeFirst();
    if (existing?.frozen) {
      res.status(409).json({ error: { code: "frozen", message: "this group already has printed codes" } });
      return;
    }
    if (prefix && (await prefixTakenByOther(db, prefix, key))) {
      res.status(409).json({ error: { code: "prefix_taken", message: `prefix '${prefix}' is already used` } });
      return;
    }
    await db
      .insertInto("labels_code_prefixes")
      .values({ group_key: key, entity_kind: parsed.data.entity_kind, prefix, label })
      .onConflict((oc) => oc.column("group_key").doUpdateSet({ prefix, updated_at: sql`now()` }))
      .execute();
    res.status(201).json({ group_key: key, prefix, label });
  }),
);

// PATCH /groups/:group_key { prefix, keep_existing? } — rename a prefix.
//
// Default: rejected once frozen (printed); it REWRITES the group's existing codes
// to the new prefix (c1 → loc1), which is fine before anything is printed.
//
// keep_existing:true is the OVERRIDE for a printed group — it moves the prefix for
// FUTURE mints only and leaves every already-minted code alone, so a sticker out in
// the world still scans to its item. The old prefix stays reserved (its codes remain
// in labels_codes; prefixTakenByOther sees them), so nothing else can reuse it and
// collide on the UNIQUE code.
// A blank prefix is allowed: it opts the list out of a code (renameCodeGroup
// clears it). Non-blank values are validated for shape inside normalizePrefix.
const PrefixBody = z.object({ prefix: z.string().max(8), keep_existing: z.boolean().optional() });
// AI-REACH: action labels:set-code — rename a prefix (shared service
// renameCodeGroup in services/codes.ts).
codesRouter.patch(
  "/groups/:group_key",
  asyncHandler(async (req, res) => {
    const parsed = PrefixBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const key = req.params.group_key;
    if (!key) {
      res.status(400).json({ error: { code: "missing_key", message: "group_key required" } });
      return;
    }
    // Shared with the labels:set-code workspace action (services/codes.ts): the
    // freeze / keep-existing / prefix-reservation rules live in one place so the
    // HTTP surface and the AI surface can never disagree about them.
    const result = await renameCodeGroup(
      tenantDb(req),
      key,
      parsed.data.prefix,
      parsed.data.keep_existing === true,
    );
    if (!result.ok) {
      const status = result.code === "bad_prefix" ? 400 : result.code === "not_found" ? 404 : 409;
      res.status(status).json({ error: { code: result.code, message: result.message } });
      return;
    }
    res.json({
      group_key: result.group_key,
      prefix: result.prefix,
      codes_rewritten: result.codes_rewritten,
      ...(result.kept_existing ? { kept_existing: true } : {}),
    });
  }),
);

// PATCH /groups/:group_key/overlay { overlay_center } — the per-GROUP QR-center
// toggle, so two instances of one kind can differ (3d-printers on, cnc off). Sets
// the group's own override; the print path reads it before the kind default.
// AI-REACH: action labels:set-code — its code_in_qr arg routes here per group.
const OverlayBody = z.object({ overlay_center: z.boolean() });
codesRouter.patch(
  "/groups/:group_key/overlay",
  asyncHandler(async (req, res) => {
    const parsed = OverlayBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const key = req.params.group_key;
    if (!key) {
      res.status(400).json({ error: { code: "missing_key", message: "group_key required" } });
      return;
    }
    const ok = await setGroupOverlay(tenantDb(req), key, parsed.data.overlay_center);
    if (!ok) {
      res.status(404).json({ error: { code: "not_found", message: "code group not found" } });
      return;
    }
    res.json({ group_key: key, overlay_center: parsed.data.overlay_center });
  }),
);
