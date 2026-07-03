// /api/v1/orgs/:slug/modules/digifab/failure — AI print-failure detection config
// + status + a manual "check now". The watch loop itself lives in
// ../failure-detect.ts; this is its HTTP surface.

import { Router } from "express";
import { z } from "zod";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { readFailureConfig, detectOnce, ewmUpdate, crossed } from "../failure-detect.js";

export const failureRouter = Router({ mergeParams: true });

// ── config (singleton) ───────────────────────────────────────────────────────
failureRouter.get(
  "/config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json(await readFailureConfig(tenantDb(req)));
  }),
);

const ConfigBody = z.object({
  enabled: z.boolean().optional(),
  threshold: z.number().min(0.1).max(0.99).optional(),
  sample_interval_sec: z.number().int().min(5).max(600).optional(),
  auto_pause: z.boolean().optional(),
  backend: z.enum(["auto", "edge", "llm"]).optional(),
});
failureRouter.put(
  "/config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "invalid failure-detection config" } });
    const db = tenantDb(req);
    const patch = { ...parsed.data, updated_at: new Date() };
    await db
      .insertInto("digifab_failure_config")
      .values({ id: true, ...patch })
      .onConflict((oc) => oc.column("id").doUpdateSet(patch))
      .execute();
    res.json(await readFailureConfig(db));
  }),
);

// ── per-device watch status (for the fleet card) ─────────────────────────────
failureRouter.get(
  "/:connectionId/:deviceId/status",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const row = await tenantDb(req)
      .selectFrom("digifab_failure_watch")
      .select(["score", "samples", "last_probability", "last_source", "paused_at", "last_sample_at", "watch_at"])
      .where("connection_id", "=", req.params.connectionId!)
      .where("device_id", "=", req.params.deviceId!)
      .executeTakeFirst();
    res.json({
      watching: !!row?.watch_at,
      score: row ? Number(row.score) : 0,
      samples: row ? Number(row.samples) : 0,
      last_probability: row?.last_probability ?? null,
      last_source: row?.last_source ?? null,
      paused: !!row?.paused_at,
      paused_at: row?.paused_at ?? null,
      last_sample_at: row?.last_sample_at ?? null,
    });
  }),
);

// ── manual "check now" — one sample, no state change ─────────────────────────
failureRouter.post(
  "/:connectionId/:deviceId/check",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const cfg = await readFailureConfig(db);
    const r = await detectOnce(db, orgId, req.params.connectionId!, req.params.deviceId!, cfg);
    if (!r) return void res.status(200).json({ available: false, reason: "no reading (no camera frame, or no model / AI provider)" });
    // Show how this single reading would move a fresh score against the threshold.
    const projected = ewmUpdate(0, r.probability);
    res.json({ available: true, probability: r.probability, source: r.source, would_trip: crossed(r.probability, cfg.threshold), projected_score: projected });
  }),
);
