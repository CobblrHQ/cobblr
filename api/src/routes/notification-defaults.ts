// How a workspace's members hear its urgent and high events until they choose
// for themselves (#6909).
//
//   GET /orgs/:slug/notification-defaults            { urgent, high, channels }
//   PUT /orgs/:slug/notification-defaults/:priority  { channel: email | discord_dm | browser_push | null }
//
// Reading is any member's; setting is the owners' and admins', through the
// action's own gate, so this page and Cobb give one answer.
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { requireCapability } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { DEFAULT_CHANNEL_WORDS, workspaceDefaults } from "../platform/notification-defaults.js";
import { applyNotificationDefault } from "../platform/notification-defaults-action.js";

export const notificationDefaultsRouter = Router({ mergeParams: true });

notificationDefaultsRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ ...(await workspaceDefaults(req.tenant!.org.id)), channels: DEFAULT_CHANNEL_WORDS });
  } catch (err) {
    next(err);
  }
});

// AI-ACTION: platform:set-notification-default
notificationDefaultsRouter.put("/:priority", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await requireCapability(req, res, "platform:set-notification-default"))) return;
    const r = await applyNotificationDefault(req.tenant!.org.id, req.session!.id, req.params.priority, (req.body ?? {}).channel ?? null);
    if (!r.ok) {
      res.status(400).json({ error: { code: "bad_default", message: r.error } });
      return;
    }
    res.json({ ...(await workspaceDefaults(req.tenant!.org.id)), was: r.data!.was });
  } catch (err) {
    next(err);
  }
});
