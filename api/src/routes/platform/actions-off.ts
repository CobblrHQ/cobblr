import { Router } from "express";
import { requireAuth } from "../../auth/middleware.js";
import { withTenant } from "../../middleware/tenant.js";
import { offOnRecord } from "../../platform/actions.js";

export const actionsOffRouter = Router({ mergeParams: true });

// GET /:slug/actions/off?kind&id — the actions this record, as it is now,
// would refuse, each with its sentence: a record's bar shows them off with
// the sentence, and the run refuses with the same one (registerRecordCheck,
// #7921 class 2). The kind's listing (GET /:slug/actions) answers per kind; this answers per record.
// AI-REACH: exempt — a read the record bar makes before drawing its buttons; the run itself refuses with the same sentence for every door
actionsOffRouter.get(
  "/:slug/actions/off",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : "";
      const id = typeof req.query.id === "string" ? req.query.id : "";
      if (!kind || !id) {
        res.status(400).json({ error: { code: "missing_record", message: "?kind=<entity-kind>&id=<record id> required" } });
        return;
      }
      res.json({ off: await offOnRecord(req.tenant!.org.id, kind, id) });
    } catch (err) {
      next(err);
    }
  },
);
