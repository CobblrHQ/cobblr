import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { stationStore } from "../platform/scan-station-store.js";
import { acknowledgeStationCommand, stationCommand, withStation, type StationCaller } from "../platform/scan-stations.js";
import { StationRefusal } from "../platform/scan-station-engine.js";

export const scanStationsRouter = Router({ mergeParams: true });
scanStationsRouter.use("/:slug/scan-stations", requireAuth, withTenant);
function caller(req: Request): StationCaller {
  return { orgId: req.tenant!.org.id, orgSlug: req.tenant!.org.slug, userId: req.session!.id, token: (req.headers.authorization || "").replace(/^Bearer\s+/i, "") };
}
function wrap(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: import("express").Response, next: import("express").NextFunction) => {
    try {
      // ROLE: any member (a station belongs to the person who configured it)
      res.json(await fn(req));
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof StationRefusal) {
        res.status(error instanceof z.ZodError ? 400 : 422).json({ error: { code: "station_refused", message: error.message } });
      } else if ((error as { status?: number }).status === 404 || (error as { status?: number }).status === 409) {
        res.status((error as { status: number }).status).json({ error: { code: "station_refused", message: (error as Error).message } });
      } else next(error);
    }
  };
}
function id(req: Request) { return z.string().uuid().parse(req.params.id); }

scanStationsRouter.get("/:slug/scan-stations", wrap(async (req) => ({ items: await stationStore.list(caller(req).orgId, caller(req).userId) })));
// AI-REACH: station setup is a physical device flow on the scan stations page
// UI-SCREEN: /scan/stations
scanStationsRouter.post("/:slug/scan-stations", wrap(async (req) => {
  const b = z.object({ name: z.string().trim().min(1).max(80), mode: z.enum(["navigate", "print", "file"]).default("file") }).parse(req.body);
  const c = caller(req);
  return stationStore.create(c.orgId, c.userId, b.name, b.mode);
}));
scanStationsRouter.get("/:slug/scan-stations/:id", wrap(async (req) => withStation(caller(req), id(req), async (engine) => engine.device)));
// AI-REACH: the station page configures what a physical scan does
scanStationsRouter.patch("/:slug/scan-stations/:id", wrap(async (req) => {
  const b = z.object({ name: z.string().trim().min(1).max(80).optional(), mode: z.enum(["navigate", "print", "file"]).optional() }).parse(req.body);
  return withStation(caller(req), id(req), async (engine) => {
    if (b.mode && b.mode !== engine.device.mode) await engine.end();
    Object.assign(engine.device, b);
    await stationStore.saveDevice(engine.device);
    return engine.device;
  });
}));
scanStationsRouter.get("/:slug/scan-stations/:id/poll", wrap(async (req) => withStation(caller(req), id(req), async (engine) => {
  const c = engine.device.command;
  if (c?.status === "waiting" && Date.parse(c.expires_at) <= Date.now()) {
    c.status = "cancelled"; c.message = "Tag request expired."; await stationStore.saveDevice(engine.device);
  }
  return { mode: engine.device.mode, context: engine.device.context, command: c?.status === "waiting" ? { ...c, expires_in_ms: Math.max(0, Date.parse(c.expires_at) - Date.now()) } : null };
})));
// AI-REACH: the reader acknowledges its queued physical tag operation
// UI-REACH: the station firmware acknowledges a tag after reading or writing it
scanStationsRouter.post("/:slug/scan-stations/:id/commands/ack", wrap(async (req) => {
  const b = z.object({ command_id: z.string().uuid(), uid: z.string().min(8).max(20), success: z.boolean() }).parse(req.body);
  return acknowledgeStationCommand(caller(req), id(req), b.command_id, b.uid, b.success);
}));
// AI-REACH: the NFC tag page queues the next physical tap
// UI-SCREEN: /labels/nfc
scanStationsRouter.post("/:slug/scan-stations/:id/commands", wrap(async (req) => {
  const b = z.object({ type: z.enum(["write", "link"]), url: z.string().url().max(500) }).parse(req.body);
  return stationCommand(caller(req), id(req), b.type, b.url);
}));
// AI-REACH: the tag page cancels the physical tap waiting on the reader
scanStationsRouter.post("/:slug/scan-stations/:id/commands/cancel", wrap(async (req) => withStation(caller(req), id(req), async (engine) => {
  if (engine.device.command?.status === "waiting") { engine.device.command.status = "cancelled"; await stationStore.saveDevice(engine.device); }
  return engine.device;
})));
scanStationsRouter.get("/:slug/scan-stations/:id/sessions", wrap(async (req) => withStation(caller(req), id(req), async () => {
  const before = z.string().datetime().optional().parse(req.query.before);
  const page = await stationStore.sessions(id(req), before);
  const items = page.slice(0, 50);
  return { items: items.map(({ actions, ...s }) => ({ ...s, count: actions.length })), next_before: page.length > 50 ? items.at(-1)?.started_at : null };
})));
scanStationsRouter.get("/:slug/scan-stations/:id/sessions/:sessionId", wrap(async (req) => withStation(caller(req), id(req), async () => stationStore.session(id(req), z.string().uuid().parse(req.params.sessionId)))));
// AI-REACH: undo is offered against the station session's recorded actions
scanStationsRouter.post("/:slug/scan-stations/:id/sessions/:sessionId/undo", wrap(async (req) => {
  const b = z.object({ action_id: z.string().uuid().optional() }).parse(req.body);
  return withStation(caller(req), id(req), async (engine) => engine.undo(await stationStore.session(id(req), z.string().uuid().parse(req.params.sessionId)), b.action_id));
}));
// AI-REACH: the station page ends its current physical scanning session
// UI-SCREEN: /scan/stations
scanStationsRouter.post("/:slug/scan-stations/:id/end", wrap(async (req) => withStation(caller(req), id(req), async (engine) => { await engine.end(); return engine.device; })));
