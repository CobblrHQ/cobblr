// /api/v1/orgs/:slug/modules/core-scan
//
// External QR resolver rules (the redirect table) + the synchronous resolve
// endpoint the camera calls on a foreign scan.
//
//   GET    /qr-rules            — list rules (member+; the camera reads this to
//                                 know whether to bother calling resolve-external)
//   POST   /qr-rules            — create a rule (admin+)
//   PATCH  /qr-rules/:id        — update a rule (admin+)
//   DELETE /qr-rules/:id        — delete a rule (admin+)
//   POST   /qr-rules/reorder    — set ordering (admin+)
//   POST   /resolve-external    — { value } → resolve outcome (member+)
//
// See docs/design-decisions/external-qr-resolver.md + services/qr-resolver.ts.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { resolveExternalScan } from "../services/qr-resolver.js";

export const qrRulesRouter = Router({ mergeParams: true });

// ───────────────────────────── validation ─────────────────────────────

const MatchSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url_prefix"), value: z.string().min(1).max(500) }),
  z.object({ type: z.literal("url_base"), value: z.string().min(1).max(500) }),
  z.object({ type: z.literal("regex"), value: z.string().min(1).max(500) }),
  z.object({ type: z.literal("bare"), value: z.string().max(500).optional() }),
]);

const ExtractSpec = z
  .object({
    source: z.enum(["path_segment_after_prefix", "capture_group", "whole_value"]).optional(),
    group: z.union([z.string().max(60), z.number().int().min(0).max(50)]).optional(),
    type_from: z.union([z.string().max(60), z.number().int().min(0).max(50)]).optional(),
    transform: z.array(z.enum(["trim", "strip_leading_zeros", "lowercase"])).max(5).optional(),
  })
  .default({});

const ResolveSpec = z
  .object({
    target_kind: z.string().max(80).optional(),
    type_map: z.record(z.string().max(80)).optional(),
    key_field: z.string().min(1).max(80),
  })
  .refine((d) => Boolean(d.target_kind) || Boolean(d.type_map), {
    message: "resolve: provide target_kind or type_map",
  });

const RuleBody = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  match: MatchSpec,
  extract: ExtractSpec,
  resolve: ResolveSpec,
});

const RulePatch = RuleBody.partial();

interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  match_spec: unknown;
  extract_spec: unknown;
  resolve_spec: unknown;
  created_at: Date;
  updated_at: Date;
}

function serialize(row: RuleRow) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    match: row.match_spec,
    extract: row.extract_spec,
    resolve: row.resolve_spec,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const jsonb = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

// ────────────────────────────── routes ──────────────────────────────

qrRulesRouter.get(
  "/qr-rules",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_scan_qr_rules")
      .selectAll()
      .orderBy("position", "asc")
      .orderBy("created_at", "asc")
      .execute();
    res.json({ rules: rows.map((r) => serialize(r as unknown as RuleRow)) });
  }),
);

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
qrRulesRouter.post(
  "/qr-rules",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = RuleBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const d = parsed.data;
    const db = tenantDb(req);
    const row = await db
      .insertInto("core_scan_qr_rules")
      .values({
        name: d.name,
        enabled: d.enabled ?? true,
        position: d.position ?? 0,
        match_spec: jsonb(d.match) as never,
        extract_spec: jsonb(d.extract) as never,
        resolve_spec: jsonb(d.resolve) as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ rule: serialize(row as unknown as RuleRow) });
  }),
);

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
qrRulesRouter.patch(
  "/qr-rules/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = RulePatch.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const d = parsed.data;
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: sql`now()` };
    if (d.name !== undefined) patch.name = d.name;
    if (d.enabled !== undefined) patch.enabled = d.enabled;
    if (d.position !== undefined) patch.position = d.position;
    if (d.match !== undefined) patch.match_spec = jsonb(d.match);
    if (d.extract !== undefined) patch.extract_spec = jsonb(d.extract);
    if (d.resolve !== undefined) patch.resolve_spec = jsonb(d.resolve);
    const row = await db
      .updateTable("core_scan_qr_rules")
      .set(patch as never)
      .where("id", "=", req.params.id as string)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "rule not found" } });
      return;
    }
    res.json({ rule: serialize(row as unknown as RuleRow) });
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
qrRulesRouter.delete(
  "/qr-rules/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const row = await db
      .deleteFrom("core_scan_qr_rules")
      .where("id", "=", req.params.id as string)
      .returning("id")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "rule not found" } });
      return;
    }
    res.status(204).end();
  }),
);

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
qrRulesRouter.post(
  "/qr-rules/reorder",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = z.object({ ids: z.array(z.string().uuid()).max(500) }).safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    await db.transaction().execute(async (tx) => {
      let pos = 0;
      for (const id of parsed.data.ids) {
        await tx
          .updateTable("core_scan_qr_rules")
          .set({ position: pos, updated_at: sql`now()` } as never)
          .where("id", "=", id)
          .execute();
        pos += 1;
      }
    });
    res.json({ ok: true });
  }),
);

// AI-REACH: a step of the guided scan/put-away flow, driven from the scanner screen with a camera in hand; the assistant reaches the inbox through list_scan_inbox and the plan through get_putaway_plan
qrRulesRouter.post(
  "/resolve-external",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = z.object({ value: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const outcome = await resolveExternalScan(db, ctx.org.id, parsed.data.value);
    res.json(outcome);
  }),
);
