// POST /orgs/:slug/field-defs/restore: put a deleted field back as it was.
// The undo of Delete field; platform.restore-definition is the same service for the
// assistant. Its own file because platform.ts takes no new route (#7385).

import { Router } from "express";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";
import { requireAuth } from "../auth/middleware.js";
import { requireCapability } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { FieldDefSnapshot, restoreFieldDef } from "../platform/field-defs.js";

export const fieldDefRestoreRouter = Router({ mergeParams: true });

// AI-ACTION: platform:restore-definition
fieldDefRestoreRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "platform:restore-definition"))) return;
    const parsed = FieldDefSnapshot.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
      return;
    }
    const result = await restoreFieldDef(req.tenant!.org.id, parsed.data);
    if (!result.ok) {
      res.status(409).json({ error: { code: result.code, message: result.message } });
      return;
    }
    res.status(201).json(result.def);
  } catch (err) {
    next(err);
  }
});
