import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { randomBytes, createHash } from "node:crypto";
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import {
  pagedAnswer,
  readListPage,
  TOTAL_COLUMN,
} from "@cobblr/platform-contract/list-page";
import { tenantDb, tenantContext, sessionUser } from "../../../db.js";
import { asyncHandler, badBody, requireRole } from "../../../api/util.js";
import { ReviewRequired } from "../../../drivers/job-review.js";
import { embroideryMutation } from "../embroidery-actions.js";
import { stationTokenHash } from "../../../laser-station.js";
import { threadStock, nearestThreads } from "../embroidery-stock.js";
import { threadChart } from "../embroidery-chart.js";
import { revokeStation } from "../../../api/stations.js";
export const embroideryRouter = Router({ mergeParams: true });
for (const parameter of ["id", "stationId"])
  embroideryRouter.param(parameter, (_req, res, next, value) => {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success) return void badBody(res, parsed.error);
    next();
  });
const refuse = (res: import("express").Response, error: unknown) => {
  if (!(error instanceof ReviewRequired || error instanceof z.ZodError))
    throw error;
  res
    .status(409)
    .json({ error: { code: "embroidery_refused", message: error.message } });
};
embroideryRouter.get(
  "/machines",
  asyncHandler(async (req, res) => {
    const page = readListPage(req.query, 20);
    res.json(
      pagedAnswer(
        await tenantDb(req)
          .selectFrom("digifab_embroidery_machines")
          .selectAll()
          .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
          .orderBy("created_at")
          .orderBy("id")
          .limit(page.limit)
          .offset(page.offset)
          .execute(),
        page,
      ),
    );
  }),
);
embroideryRouter.get(
  "/designs",
  asyncHandler(async (req, res) => {
    const page = readListPage(req.query, 20);
    res.json(
      pagedAnswer(
        await tenantDb(req)
          .selectFrom("digifab_embroidery_designs")
          .select(["id", "name", "summary", "created_at"])
          .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
          .orderBy("created_at", "desc")
          .orderBy("id")
          .limit(page.limit)
          .offset(page.offset)
          .execute(),
        page,
      ),
    );
  }),
);
embroideryRouter.get(
  "/runs",
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().safeParse(req.query.machine_id);
    if (!id.success) return badBody(res, id.error);
    const page = readListPage(req.query, 20);
    res.json(
      pagedAnswer(
        await tenantDb(req)
          .selectFrom("digifab_embroidery_runs")
          .selectAll()
          .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
          .where("machine_id", "=", id.data)
          .orderBy("created_at", "desc")
          .orderBy("job_id")
          .limit(page.limit)
          .offset(page.offset)
          .execute(),
        page,
      ),
    );
  }),
);
embroideryRouter.get(
  "/spools",
  asyncHandler(async (req, res) => {
    try {
      const stock = await threadStock(tenantContext(req).org.id, {
        ...readListPage(req.query, 20),
        q: typeof req.query.q === "string" ? req.query.q : undefined,
      });
      const design =
        typeof req.query.design_id === "string"
          ? await tenantDb(req)
              .selectFrom("digifab_embroidery_designs")
              .select("summary")
              .where("id", "=", req.query.design_id)
              .executeTakeFirst()
          : null;
      res.json({
        ...stock,
        suggestions:
          design?.summary.stops.map((s) => ({
            index: s.index,
            threads: nearestThreads(s.color, stock.items, s.brand, s.code),
          })) ?? [],
      });
    } catch (error) {
      refuse(res, error);
    }
  }),
);
embroideryRouter.get(
  "/chart",
  asyncHandler(async (req, res) => {
    const { limit, offset } = readListPage(req.query, 20),
      q = String(req.query.q ?? "").toLowerCase(),
      brand = String(req.query.brand ?? "");
    const rows = threadChart.filter(
      (t) =>
        (!brand || t.brand === brand) &&
        (!q || `${t.brand} ${t.code} ${t.name}`.toLowerCase().includes(q)),
    );
    res.json({
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      complete: offset + limit >= rows.length,
      brands: [...new Set(threadChart.map((t) => t.brand))],
    });
  }),
);
// AI-ACTION: digifab:embroidery-job
// UI-SCREEN: /digifab/embroidery
// GATE: one route for two actions by operation: setting up and preparing gate on digifab:embroidery-job, a prepared run's start, interrupt and outcome on digifab:station-run (#6672)
embroideryRouter.post(
  "/actions",
  asyncHandler(async (req, res) => {
    // ADMIN-ONLY: setting up a machine and preparing a run stay with the admin tier, at every door (#5170);
    // starting, interrupting and recording a prepared run is an operator's too (digifab:station-run, #6672)
    const atStation = ["start", "interrupt", "outcome"].includes(String(req.body?.operation));
    if (!(await requireCapability(req, res, atStation ? "digifab:station-run" : "digifab:embroidery-job"))) return;
    try {
      res.json(
        await embroideryMutation(
          tenantDb(req),
          tenantContext(req).org.id,
          sessionUser(req)?.id ?? "",
          req.body.operation,
          req.body.id,
          req.body.fields ?? {},
        ),
      );
    } catch (error) {
      refuse(res, error);
    }
  }),
);
embroideryRouter.get(
  "/runs/:id/export",
  asyncHandler(async (req, res) => {
    try {
      const row = await tenantDb(req)
        .selectFrom("digifab_embroidery_runs")
        .select("plan")
        .where("job_id", "=", req.params.id!)
        .executeTakeFirst();
      if (!row) return void res.sendStatus(404);
      const file = await platform().files.read(
        tenantContext(req).org.id,
        row.plan.file_id,
      );
      if (!file) return void res.sendStatus(404);
      if (
        createHash("sha256").update(file.bytes).digest("hex") !==
        row.plan.content_hash
      )
        throw new ReviewRequired(
          "The prepared machine file changed. Discard this run and prepare a new one.",
        );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${row.plan.filename}"`,
      );
      res.type("application/octet-stream").send(Buffer.from(file.bytes));
    } catch (error) {
      refuse(res, error);
    }
  }),
);
// AI-REACH: exempt Enrollment creates a credential on the physical station. Owner/admin setup only, matching /stations registration; the assistant cannot authorize its own screen.
embroideryRouter.post(
  "/machines/:id/stations",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const b = z
      .object({ label: z.string().trim().min(1).max(100) })
      .safeParse(req.body);
    if (!b.success) return badBody(res, b.error);
    const db = tenantDb(req),
      machine = await db
        .selectFrom("digifab_embroidery_machines")
        .select("id")
        .where("id", "=", req.params.id!)
        .executeTakeFirst();
    if (!machine) return void res.sendStatus(404);
    const token = randomBytes(32).toString("hex");
    const row = await db
      .insertInto("digifab_stations")
      .values({
        connection_id: machine.id,
        remote_device_id: "embroidery",
        label: b.data.label,
        token_hash: stationTokenHash(token),
        revoked_at: null,
      })
      .returning(["id", "label"])
      .executeTakeFirstOrThrow();
    res.status(201).json({ ...row, token });
  }),
);
// AI-REACH: exempt Checks a station credential this browser holds; the assistant never handles station credentials
// GATE: a person who may run a prepared job at its station (digifab:station-run) learns only whether THIS screen's credential is authorized for this machine: no station list, setup or revocation (#7173)
embroideryRouter.post(
  "/machines/:id/stations/check",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "digifab:station-run"))) return;
    const b = z.object({ station_id: z.string().uuid(), token: z.string().min(32).max(128) }).safeParse(req.body);
    if (!b.success) return badBody(res, b.error);
    const station = await tenantDb(req)
      .selectFrom("digifab_stations")
      .select("id")
      .where("id", "=", b.data.station_id)
      .where("connection_id", "=", req.params.id!)
      .where("remote_device_id", "=", "embroidery")
      .where("token_hash", "=", stationTokenHash(b.data.token))
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    res.json({ authorized: !!station });
  }),
);
embroideryRouter.get(
  "/machines/:id/stations",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const page = readListPage(req.query, 20),
      current = z
        .string()
        .uuid()
        .optional()
        .safeParse(req.query.q || undefined);
    if (!current.success) return badBody(res, current.error);
    let query = tenantDb(req)
      .selectFrom("digifab_stations")
      .select(["id", "label", "revoked_at", "created_at"])
      .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
      .where("connection_id", "=", req.params.id!)
      .where("remote_device_id", "=", "embroidery");
    if (current.data) query = query.where("id", "=", current.data);
    res.json(
      pagedAnswer(
        await query
          .orderBy("created_at")
          .orderBy("id")
          .limit(page.limit)
          .offset(page.offset)
          .execute(),
        page,
      ),
    );
  }),
);
// AI-ACTION: digifab:revoke-station
embroideryRouter.delete(
  "/machines/:id/stations/:stationId",
  asyncHandler(async (req, res) => {
    // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
    if (!(await requireCapability(req, res, "digifab:revoke-station"))) return;
    const db = tenantDb(req);
    const station = await db
      .selectFrom("digifab_stations")
      .select("id")
      .where("id", "=", req.params.stationId!)
      .where("connection_id", "=", req.params.id!)
      .where("remote_device_id", "=", "embroidery")
      .executeTakeFirst();
    if (station) await revokeStation(db, tenantContext(req).org.id, sessionUser(req)?.id ?? null, station.id);
    res.json({ ok: true });
  }),
);
