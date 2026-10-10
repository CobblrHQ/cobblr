// Station devices: a tablet approved to be one station (#4640). The logic and
// the why are in platform/station-devices.ts.
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { makeIpLimiter, overLimit, rateLimited } from "../platform/ip-limiter.js";
import {
  approveStation,
  claimStation,
  claimStationQr,
  disableStationQr,
  listStationDevices,
  requestStationApproval,
  revokeStationDevice,
  rotateStationQr,
  stationQrState,
} from "../platform/station-devices.js";
import { isStationAddress } from "@cobblr/platform-contract/station-screen";

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

// A phone opened a station's kitchen QR (#5353): its key buys a token for
// that station's few presses. A guessed key costs the guesser this limit.
const qrLimiter = makeIpLimiter(60_000, 10);
// AI-REACH: exempt, spoken by a phone that opened a printed QR; the assistant has no label to hold.
// UI-REACH: the station page opened from the kitchen QR (web/src/pages/StationPage.tsx)
stationPublicRouter.post("/qr/claim", async (req, res, next) => {
  if (overLimit(qrLimiter, req)) return void rateLimited(res);
  try {
    res.setHeader("cache-control", "no-store");
    const body = (req.body ?? {}) as { slug?: unknown; address?: unknown; key?: unknown };
    const r = await claimStationQr(body);
    if (!r.ok) {
      res.status(403).json({ error: { code: "station_qr_unusable", message: "This QR no longer opens the station. Ask for the new label, or sign in." } });
      return;
    }
    res.json(r);
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

// The kitchen QR's switch (#5353): its state, print a label (a fresh key that
// retires the old one), turn it off.
stationDevicesRouter.get("/qr/:address", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  try {
    res.json(await stationQrState(req.tenant!.org.id, req.params.address ?? ""));
  } catch (e) {
    next(e);
  }
});

// AI-REACH: exempt, printing a label that lets people without an account in is a security step a person takes at the station's settings.
stationDevicesRouter.post("/qr/:address", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  try {
    const address = req.params.address ?? "";
    if (!isStationAddress(address)) {
      res.status(400).json({ error: { code: "bad_station_address", message: "That is not a station address." } });
      return;
    }
    const r = await rotateStationQr({ orgId: req.tenant!.org.id, userId: req.session!.id, address });
    res.json({ key: r!.key, ...(await stationQrState(req.tenant!.org.id, address)) });
  } catch (e) {
    next(e);
  }
});

// AI-REACH: exempt, the same security step as printing it.
stationDevicesRouter.delete("/qr/:address", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  try {
    await disableStationQr(req.tenant!.org.id, req.params.address ?? "");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
