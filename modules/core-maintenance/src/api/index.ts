// core-maintenance router. Mounted at
//   /api/v1/orgs/:slug/modules/core-maintenance/.

import { Router } from "express";
import { entriesRouter } from "./entries.js";
import { tick } from "../sweeper.js";
import { registerMaintenanceHandlers } from "./handlers.js";

const router = Router({ mergeParams: true });
router.use("/entries", entriesRouter);

// Synchronous tick endpoint — fires the due-soon sweeper for THIS
// workspace only. Used by tests + ops; the background interval
// still ticks across every workspace once an hour.
router.post("/sweep", (req, res, next) => {
  void (async () => {
    const tenant = (req as unknown as { tenant?: { org: { id: string } } }).tenant;
    if (!tenant) {
      res.status(401).json({ error: { code: "no_tenant", message: "tenant context required" } });
      return;
    }
    const result = await tick({ orgId: tenant.org.id });
    res.json(result);
  })().catch(next);
});

export default router;

// Side-effect: the assistant's door to the service log. Without these this
// module has no entity kind and no action, so it can be read and never added to.
registerMaintenanceHandlers();
