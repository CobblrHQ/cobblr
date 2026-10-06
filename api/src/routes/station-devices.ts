// Station devices: a tablet approved to be one station (#4640). The logic and
// the why are in platform/station-devices.ts.
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { makeIpLimiter, overLimit, rateLimited } from "../platform/ip-limiter.js";
import { approveStation, claimStation, listStationDevices, requestStationApproval, revokeStationDevice } from "../platform/station-devices.js";

/** The tablet's half: no session, so a per-IP limit stands in front of both. */
export const stationPublicRouter = Router();
const askLimiter = makeIpLimiter(60_000, 10);
const pollLimiter = makeIpLimiter(60_000, 40);

// AI-REACH: exempt, spoken by a tablet asking to become a station; a person approves it on their own screen.
// UI-REACH: the station page's "Approve this screen" view (web/src/pages/StationPage.tsx)
stationPublicRouter.post("/requests", async (req, res, next) => {
  if (overLimit(askLimiter, req)) return void rateLimited(res);
  try {
    const body = (req.body ?? {}) as { slug?: unknown; address?: unknown };
    const r = await requestStationApproval({ slug: String(body.slug ?? ""), address: String(body.address ?? "") });
    if (!r) {
      res.status(400).json({ error: { code: "bad_station_address", message: "That is not a station address." } });
      return;
    }
    res.status(201).json(r);
  } catch (e) {
    next(e);
  }
});

// The tablet's poll: pending until approved, then its token, once.
stationPublicRouter.get("/requests/:id", async (req, res, next) => {
  if (overLimit(pollLimiter, req)) return void rateLimited(res);
  try {
    res.setHeader("cache-control", "no-store");
    res.json(await claimStation(req.params.id ?? "", req.query.key));
  } catch (e) {
    next(e);
  }
});

/** The workspace's half: approve a tablet, list and stop them. */
export const stationDevicesRouter = Router({ mergeParams: true });
stationDevicesRouter.use(requireAuth, withTenant);

// AI-REACH: exempt, approving a screen is done by a person reading its code; the assistant cannot see the tablet.
stationDevicesRouter.post("/approve", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  try {
    const body = (req.body ?? {}) as { code?: unknown; label?: unknown };
    const r = await approveStation({
      orgId: req.tenant!.org.id,
      orgSlug: req.tenant!.org.slug,
      userId: req.session!.id,
      code: body.code,
      label: typeof body.label === "string" ? body.label : null,
    });
    if (!r.ok) {
      res.status(r.reason === "unknown" ? 404 : 409).json({
        error:
          r.reason === "unknown"
            ? { code: "station_code_unusable", message: "That code is wrong, expired or already used. The screen shows a new one when it reloads." }
            : { code: "station_other_workspace", message: "That screen is asking to join another workspace. Open this workspace's station address on it instead." },
      });
      return;
    }
    res.json(r);
  } catch (e) {
    next(e);
  }
});

stationDevicesRouter.get("/", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  try {
    res.json({ items: await listStationDevices(req.tenant!.org.id) });
  } catch (e) {
    next(e);
  }
});

// AI-REACH: exempt, stopping a screen is a security step a person takes; the token list is a guarded surface.
stationDevicesRouter.delete("/:id", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  try {
    const ok = await revokeStationDevice(req.tenant!.org.id, req.params.id ?? "");
    if (!ok) {
      res.status(404).json({ error: { code: "not_found", message: "No such station device." } });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
