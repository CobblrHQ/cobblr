// Mounted at /api/v1/orgs/:slug/modules/core-notifications/. No routes of
// its own: the module's one action is registered here (#6070).
import { Router } from "express";
import { registerMessageSomeone } from "./message-someone-action.js";

registerMessageSomeone();

const router = Router({ mergeParams: true });
export default router;
