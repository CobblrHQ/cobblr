// /orgs/:slug/record-move — move records between instances of one module.
//
// POST /preview  → what would happen, without doing it
// POST /         → do it
//
// The preview is not decoration. Moving a record can leave custom-field values
// unlabeled in the target (their def is keyed to the old kind), and the user
// agrees to carrying those defs BEFORE anything is written. See
// docs/design-decisions/move-between-instances.md.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { MoveError, getMover, moveRecords, planMove } from "../platform/move-records.js";

export const recordMoveRouter = Router({ mergeParams: true });

type Req = import("express").Request;
type Res = import("express").Response;

/** Moving records is an edit, not an admin act: the same bar as changing them. */
function requireEditor(req: Req, res: Res): boolean {
  const role = (req as unknown as { tenant?: { role: string } }).tenant?.role;
  if (role === "owner" || role === "admin" || role === "editor") return true;
  res.status(403).json({
    error: { code: "forbidden", message: "Requires owner, admin, or editor role." },
  });
  return false;
}

const bodySchema = z.object({
  module: z.string().min(1).max(80),
  ids: z.array(z.string().min(1)).min(1).max(1000),
  from: z.string().min(1).max(80),
  to: z.string().min(1).max(80),
  carry_fields: z.array(z.string()).optional(),
});

function orgId(req: Req): string {
  return (req as unknown as { tenant: { org: { id: string } } }).tenant.org.id;
}

/** MoveError carries a code for the cases a user can act on (a cross-module
 *  target, a vanished instance); anything else is a real 500. */
function fail(res: Res, err: unknown): void {
  if (err instanceof MoveError) {
    const status = err.code === "no_mover" ? 400 : err.code === "cross_module" ? 400 : 400;
    res.status(status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  throw err;
}

// AI-REACH: a read. The dry run of the move below, which is the route that
// needs the door; showing what would happen changes nothing.
recordMoveRouter.post("/preview", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireEditor(req, res)) return;
    const body = bodySchema.parse(req.body);
    const mover = getMover(body.module);
    if (!mover) {
      res.status(400).json({
        error: { code: "no_mover", message: `${body.module} does not support moving records.` },
      });
      return;
    }
    const metadatas = await mover.metadataFor(orgId(req), body.ids);
    const plan = await planMove(
      orgId(req),
      body.module,
      body.ids,
      body.from,
      body.to,
      metadatas,
    );
    res.json(plan);
  } catch (err) {
    try {
      fail(res, err);
    } catch (rethrown) {
      next(rethrown);
    }
  }
});

recordMoveRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireEditor(req, res)) return;
    const body = bodySchema.parse(req.body);
    const result = await moveRecords(orgId(req), body.module, body.ids, body.from, body.to, {
      carryFields: body.carry_fields,
    });
    res.json(result);
  } catch (err) {
    try {
      fail(res, err);
    } catch (rethrown) {
      next(rethrown);
    }
  }
});
