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
  groupValueOf,
  declaredOverlayDefault,
} from "../services/codes.js";

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
codesRouter.patch(
  "/config",
  asyncHandler(async (req, res) => {
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { kind, group_field, overlay_center } = parsed.data;
    // Insert only the provided columns; on conflict, update just what was sent
    // so the two settings stay independent. When this PATCH only sets the grain
    // and CREATES the row, seed overlay_center with the kind's module-declared
    // default (not the DB column default of true) so a group_field edit can't
    // silently flip a default-OFF kind (e.g. a location) back ON. It's put on
    // the insert `values` only, never the conflict `set`, so an existing row's
    // saved toggle is preserved.
    const values: Record<string, unknown> = { entity_kind: kind, updated_at: sql`now()` };
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    if (group_field !== undefined) { values.group_field = group_field; set.group_field = group_field; }
    if (overlay_center !== undefined) {
      values.overlay_center = overlay_center;
      set.overlay_center = overlay_center;
    } else {
      values.overlay_center = await declaredOverlayDefault(kind);
    }
    const db = tenantDb(req);
    await db
      .insertInto("labels_code_config")
      .values(values as never)
      .onConflict((oc) => oc.column("entity_kind").doUpdateSet(set as never))
      .execute();
    const row = await db
      .selectFrom("labels_code_config")
      .select(["group_field", "overlay_center"])
      .where("entity_kind", "=", kind)
      .executeTakeFirst();
    res.json({
      entity_kind: kind,
      group_field: row?.group_field ?? "instance",
      overlay_center: row?.overlay_center ?? (await declaredOverlayDefault(kind)),
    });
  }),
);

// GET /groups — every code group with its prefix + count, for the management UI.
codesRouter.get(
  "/groups",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req)
      .selectFrom("labels_code_prefixes")
      .select(["group_key", "entity_kind", "prefix", "label", "next_seq", "frozen"])
      .orderBy("entity_kind")
      .orderBy("prefix")
      .execute();
    res.json({ groups: rows.map((r) => ({ ...r, count: Number(r.next_seq) - 1 })) });
  }),
);

// POST /groups { entity_kind, group_field, group_value, prefix } — pre-seed a
// group's prefix BEFORE any label is printed, so the user picks a memorable one
// up front. Rejected once the group has printed codes (frozen).
const SeedBody = z.object({
  entity_kind: z.string().min(1).max(120),
  group_field: z.string().min(1).max(80).default("instance"),
  group_value: z.string().min(1).max(200),
  prefix: z.string().min(1).max(8),
});
codesRouter.post(
  "/groups",
  asyncHandler(async (req, res) => {
    const parsed = SeedBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    let prefix: string;
    try {
      prefix = normalizePrefix(parsed.data.prefix);
    } catch (e) {
      res.status(400).json({ error: { code: "bad_prefix", message: (e as Error).message } });
      return;
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
    const clash = await db
      .selectFrom("labels_code_prefixes")
      .select(["group_key"])
      .where("prefix", "=", prefix)
      .where("group_key", "!=", key)
      .executeTakeFirst();
    if (clash) {
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

// PATCH /groups/:group_key { prefix } — rename a prefix. Rejected once frozen
// (printed), because reusing/churning a prefix that has codes would collide.
const PrefixBody = z.object({ prefix: z.string().min(1).max(8) });
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
    const db = tenantDb(req);
    let prefix: string;
    try {
      prefix = normalizePrefix(parsed.data.prefix);
    } catch (e) {
      res.status(400).json({ error: { code: "bad_prefix", message: (e as Error).message } });
      return;
    }
    const grp = await db
      .selectFrom("labels_code_prefixes")
      .selectAll()
      .where("group_key", "=", key)
      .executeTakeFirst();
    if (!grp) {
      res.status(404).json({ error: { code: "not_found", message: "code group not found" } });
      return;
    }
    if (grp.frozen) {
      res.status(409).json({ error: { code: "frozen", message: "labels have already been printed under this prefix, so it can't change" } });
      return;
    }
    const clash = await db
      .selectFrom("labels_code_prefixes")
      .select(["group_key"])
      .where("prefix", "=", prefix)
      .where("group_key", "!=", key)
      .executeTakeFirst();
    if (clash) {
      res.status(409).json({ error: { code: "prefix_taken", message: `prefix '${prefix}' is already used` } });
      return;
    }
    // Rewrite the group's ALREADY-MINTED codes too. `labels_codes.code` stores
    // the whole `<prefix><seq>` string (it's what a scan/typed lookup matches),
    // so renaming only the group would strand every existing code under the old
    // prefix — c1 would still resolve while the group claims to be `loc`. This
    // never bit before because a group froze on its first mint and so could
    // never be both renameable and non-empty; now that freezing waits for a
    // print, it can be. One transaction: prefix + codes move together.
    const renamed = await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("labels_code_prefixes")
        .set({ prefix, updated_at: sql`now()` })
        .where("group_key", "=", key)
        .execute();
      const rows = await trx
        .updateTable("labels_codes")
        .set({ prefix, code: sql`${prefix} || seq::text` })
        .where("group_key", "=", key)
        .returning("code")
        .execute();
      return rows.length;
    });
    res.json({ group_key: key, prefix, codes_rewritten: renamed });
  }),
);
