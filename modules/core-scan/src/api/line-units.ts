// An order line's units (#5734). The owner: "The important distinction is
// 10 different things vs qty 10 of the same thing." A line of the same
// thing stays one row whose units scans count; a pack of different things
// becomes its parts. The card's doors; the assistant and the MCP server come
// through the same operations as core-scan actions (line-units-ops.ts).

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { lineUnitsOf } from "@cobblr/platform-contract/line-units";
import { bearer, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { INTERNAL_API, servedAll } from "./inbox.js";
import { mergeMeta } from "../services/metadata.js";
import { lineForOrderItem, lineSlots } from "../services/line-slots.js";
import { fillOrderLine, rejoinOrderLine, setLineUnits, splitOffUnits, unfillOrderLine, type LineDoor, type LineOpResult } from "../services/line-units-ops.js";

export const lineUnitsRouter = Router({ mergeParams: true });

function doorOf(req: Request): LineDoor {
  const ctx = tenantContext(req);
  return { db: tenantDb(req), orgId: ctx.org.id, orgSlug: ctx.org.slug, userId: sessionUser(req).id, token: bearer(req), baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API };
}

async function rowsServed(req: Request, ids: string[]) {
  const rows = ids.length ? await tenantDb(req).selectFrom("core_scan_inbox_items").selectAll().where("id", "in", ids).execute() : [];
  return servedAll(req, rows as never[]);
}

async function answer(req: Request, res: Response, r: LineOpResult): Promise<void> {
  if (!r.ok) {
    res.status(r.status).json({ error: { code: r.code, message: r.message, ...(r.item_id ? { item_id: r.item_id } : {}) } });
    return;
  }
  res.json({ ...(r.received !== undefined ? { received: r.received } : {}), ...(r.count !== undefined ? { count: r.count } : {}), items: await rowsServed(req, r.ids) });
}

const Units = z.object({ mode: z.enum(["same", "different"]) });

// The line says which it is, and a person switches it in one tap: "a pack of
// 10 different" makes its ten rows; "they are all the same" puts a split
// line back together while none of its parts is filed.
// AI-ACTION: core-scan:set-line-units
lineUnitsRouter.post(
  "/inbox/:id/units",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:set-line-units"))) return;
    const body = Units.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: { code: "bad_body", message: "mode is same or different" } });
      return;
    }
    await answer(req, res, await setLineUnits(doorOf(req), String(req.params.id), body.data.mode));
  }),
);

const SplitOff = z.object({ count: z.number().int().min(1), name: z.string().trim().min(1).max(300).optional() });

// Some of a line's units differ ("8 white, 2 black"): they leave as one row
// of their own, which a person names; the line keeps the rest.
// AI-ACTION: core-scan:split-off-units
lineUnitsRouter.post(
  "/inbox/:id/split-off",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:split-off-units"))) return;
    const body = SplitOff.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: { code: "bad_body", message: "count is how many to split off" } });
      return;
    }
    await answer(req, res, await splitOffUnits(doorOf(req), String(req.params.id), body.data.count, body.data.name));
  }),
);

// A part split off goes back into its line.
// AI-ACTION: core-scan:rejoin-order-line
lineUnitsRouter.post(
  "/inbox/:id/rejoin",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:rejoin-order-line"))) return;
    await answer(req, res, await rejoinOrderLine(doorOf(req), String(req.params.id)));
  }),
);

const Fill = z.object({ line_id: z.string().uuid().optional(), order_item_id: z.string().uuid().optional() }).refine((b) => !!(b.line_id || b.order_item_id), "line_id or order_item_id");

// This scan is one of an order line's units: it fills a slot ("3 of 10
// received") and makes nothing new. A scan fills at most one slot, ever.
// AI-ACTION: core-scan:fill-order-line
lineUnitsRouter.post(
  "/inbox/:id/fill-line",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:fill-order-line"))) return;
    const body = Fill.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: { code: "bad_body", message: "line_id (an inbox order line) or order_item_id (a purchase line) is required" } });
      return;
    }
    await answer(req, res, await fillOrderLine(doorOf(req), String(req.params.id), body.data));
  }),
);

// The scan was not one of the line's units after all: the slot is free.
// AI-ACTION: core-scan:unfill-order-line
lineUnitsRouter.delete(
  "/inbox/:id/fill-line",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:unfill-order-line"))) return;
    await answer(req, res, await unfillOrderLine(doorOf(req), String(req.params.id)));
  }),
);

// What a line holds and which scans filled it; by the inbox line, or by the
// purchase's own line (the purchase page's "Scan the items"). The assistant
// reads the same count on the line itself (line_received, get_scan_item).
lineUnitsRouter.get(
  "/inbox/line-slots",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const db = tenantDb(req);
    const lineId =
      typeof req.query.line_id === "string"
        ? req.query.line_id
        : typeof req.query.order_item_id === "string"
          ? await lineForOrderItem(db, req.query.order_item_id)
          : typeof req.query.batch_id === "string"
            ? ((await db.selectFrom("core_scan_batches").select("fills_line").where("id", "=", req.query.batch_id).executeTakeFirst())?.fills_line ?? null)
            : null;
    const slots = lineId ? await lineSlots(db, lineId) : null;
    if (!slots) {
      res.status(404).json({ error: { code: "no_line", message: "No open order line of several by that id." } });
      return;
    }
    res.json(slots);
  }),
);

// "Part of Kingroon 3D #KR52731, line 1?" answered no: the offer goes and is
// not made again for this scan.
// AI-REACH: exempt — declining a suggestion only; the assistant answers yes through fill_order_line and no by not calling it
lineUnitsRouter.post(
  "/inbox/:id/line-offer/decline",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const id = String(req.params.id);
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ line_offer_declined: true }, ["line_offer"]) as never, updated_at: new Date() })
      .where("id", "=", id)
      .execute();
    res.json({ items: await rowsServed(req, [id]) });
  }),
);

// "Scan the items": a session bound to this line. Every scan made in it, by
// camera, scanner or photo, fills one of the line's slots once its match
// settles; the scan page opens on it.
// AI-REACH: exempt — opens a camera session for a person holding the things; the assistant counts a unit through fill_order_line
lineUnitsRouter.post(
  "/inbox/:id/scan-session",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const line = await db.selectFrom("core_scan_inbox_items").select(["id", "status", "source_kind", "quantity", "suggested_name", "suggested_metadata"]).where("id", "=", String(req.params.id)).executeTakeFirst();
    const units = line && line.source_kind === "receipt" && line.status === "pending" ? lineUnitsOf(line) : null;
    if (!line || !units || units.mode !== "same") {
      res.status(409).json({ error: { code: "not_a_line", message: "Only an open order line of the same thing has units to scan in." } });
      return;
    }
    const batch = await db
      .insertInto("core_scan_batches")
      .values({ created_by_user_id: sessionUser(req).id, label: `Scanning in: ${line.suggested_name ?? "an order line"}`.slice(0, 200), fills_line: line.id })
      .returning("id")
      .executeTakeFirstOrThrow();
    res.status(201).json({ batch_id: batch.id });
  }),
);
