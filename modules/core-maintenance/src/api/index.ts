import { registerRenewalsPresence } from "../renewals-presence.js";
// core-maintenance router. Mounted at
//   /api/v1/orgs/:slug/modules/core-maintenance/.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { remindersRouter } from "./reminders.js";
import { entriesRouter } from "./entries.js";
import { schedulesRouter } from "./schedules.js";
import { termsRouter, endRenewalRoute } from "./terms.js";
import { asyncHandler } from "./util.js";
import { tick } from "../sweeper.js";
import { registerMaintenanceHandlers } from "./handlers.js";
import { documentRenewalsRouter } from "./document-renewals.js";
import { registerRenewDocumentAction } from "./renew-document-action.js";

registerRenewDocumentAction();

const router = Router({ mergeParams: true });
router.use("/entries", entriesRouter);
router.use("/reminders", remindersRouter);
router.use("/schedules", schedulesRouter);
router.use("/terms", termsRouter);
router.use("/document-renewals", documentRenewalsRouter);
// AI-ACTION: core-maintenance:end-renewal
router.post("/schedules/:id/end", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-maintenance:end-renewal"))) return;
  await endRenewalRoute(req, res);
}));

// Synchronous tick endpoint — fires the due-soon sweeper for THIS
// workspace only. Used by tests + ops; the background interval
// still ticks across every workspace once an hour.
// AI-REACH: exempt — an operator's and the tests' tick of the hourly sweep; it
// sends every due reminder at once, which only the sweep's own clock may do
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
registerRenewalsPresence();
