// A press that comes from an action label (#3897) says so on the ledger:
// "Alex took 1 · via label 'Bathroom'". The label page sends the label's code
// in `x-cobblr-label` beside an ordinary invoke; this checks the code against
// the workspace's live labels before anything runs, so a revoked or foreign
// label does nothing, and marks every activity row the press writes.
//
// Only the person who pressed can send it, and the actor is still that
// person: a code names HOW they acted, the way the MCP client header does,
// never who.

import type { Request, Response, NextFunction } from "express";
import { meta } from "../db/meta.js";
import { runVia } from "../lib/request-context.js";

export async function labelVia(req: Request, res: Response, next: NextFunction): Promise<void> {
  const code = String(req.headers["x-cobblr-label"] ?? "").trim();
  if (!code) return next();
  try {
    const row = await meta
      .selectFrom("core_labels_qr_tokens")
      .select(["config", "revoked_at", "expires_at", "mode"])
      .where("token", "=", code)
      .where("org_id", "=", req.tenant!.org.id)
      .executeTakeFirst();
    const dead = !row || row.mode !== "action" || row.revoked_at || (row.expires_at && row.expires_at.getTime() < Date.now());
    if (dead) {
      res.status(410).json({ error: { code: "label_revoked", message: "This label has been turned off, so nothing was changed." } });
      return;
    }
    const title = typeof row.config?.title === "string" && row.config.title.trim() ? row.config.title.trim() : "action label";
    runVia({ kind: "label", label: title }, () => next());
  } catch (err) {
    next(err);
  }
}
