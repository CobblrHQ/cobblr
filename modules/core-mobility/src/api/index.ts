// core-mobility router. Mounted at /api/v1/orgs/:slug/modules/core-mobility/.
// The module ships no HTTP surface of its own (its behaviour is the two action
// handlers + the contributed wire/fields) — the empty router just satisfies the
// module's `api` entrypoint and registers the handlers at load.

import { Router } from "express";
import { registerActionHandlers } from "./action-handlers.js";

registerActionHandlers(); // core-mobility.recompute-away + .return-home

const router = Router({ mergeParams: true });

export default router;
