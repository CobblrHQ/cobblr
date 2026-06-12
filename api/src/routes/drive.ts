// /orgs/:slug/drive — Claude drives the web app you have open (Feature 3).
//
// Real-time relay over SSE (server→client push) + POST (client→server). A
// "driver" (Claude, via the MCP server) and the user's open TABS join a room
// keyed by (user, workspace); the driver navigates the user's CHOSEN tab and —
// only with navigate_observe — receives a batched stream of the user's actions.
//
// Permission: a STANDING grant per (user, workspace), default off. Every stream
// / navigate / telemetry call re-checks it, so revoking is immediate. The driver
// authenticates as the user (a drive:control-scoped token) — Claude can only ever
// drive YOUR tabs in YOUR workspace.
//
// Auth split: the browser tab's SSE uses EventSource (can't send an Authorization
// header), so it presents a short-lived signed TICKET minted by an authed POST.
// Everything else is normal Bearer auth (the driver is a Node MCP client; the
// tab's POSTs are fetch, which can set headers).

import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { SignJWT, jwtVerify } from "jose";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { driveHub } from "../platform/drive-hub.js";
import type { DriveMode } from "../db/schema.js";

export const driveRouter = Router({ mergeParams: true });

const secret = () => new TextEncoder().encode(env.JWT_SECRET);
const TICKET_AUD = "drive-tab";
const TICKET_TTL_S = 60;

async function signTicket(userId: string, orgId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ org: orgId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cobblr")
    .setAudience(TICKET_AUD)
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + TICKET_TTL_S)
    .sign(secret());
}
async function verifyTicket(ticket: string): Promise<{ userId: string; orgId: string } | null> {
  try {
    const { payload } = await jwtVerify(ticket, secret(), { issuer: "cobblr", audience: TICKET_AUD, algorithms: ["HS256"] });
    if (typeof payload.sub === "string" && typeof payload.org === "string") {
      return { userId: payload.sub, orgId: payload.org };
    }
    return null;
  } catch {
    return null;
  }
}

async function getMode(userId: string, orgId: string): Promise<DriveMode> {
  const row = await meta
    .selectFrom("browser_drive_grants")
    .select("mode")
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return (row?.mode as DriveMode | undefined) ?? "off";
}

/** Open an SSE stream and return a typed `send`. Heartbeats every 25s so proxies
 *  don't reap the idle connection; the caller wires req.on("close"). */
function openSse(res: Response): { send: (event: string, data: unknown) => void; stop: () => void } {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  const hb = setInterval(() => res.write(": ping\n\n"), 25000);
  return {
    send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    stop: () => clearInterval(hb),
  };
}

// ── standing permission ──────────────────────────────────────────────────────
driveRouter.get("/:slug/drive/grant", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ mode: await getMode(req.session!.id, req.tenant!.org.id) });
  } catch (err) {
    next(err);
  }
});

const GrantBody = z.object({ mode: z.enum(["off", "navigate", "navigate_observe"]) });
driveRouter.put("/:slug/drive/grant", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = GrantBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "mode must be off | navigate | navigate_observe" } });
      return;
    }
    const userId = req.session!.id;
    const orgId = req.tenant!.org.id;
    await meta
      .insertInto("browser_drive_grants")
      .values({ user_id: userId, org_id: orgId, mode: parsed.data.mode, updated_at: new Date() })
      .onConflict((c) => c.columns(["user_id", "org_id"]).doUpdateSet({ mode: parsed.data.mode, updated_at: new Date() }))
      .execute();
    res.json({ mode: parsed.data.mode });
  } catch (err) {
    next(err);
  }
});

// ── tab side ─────────────────────────────────────────────────────────────────
// Mint the SSE ticket (authed) — the tab then opens the stream with it.
driveRouter.post("/:slug/drive/tab/ticket", requireAuth, withTenant, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    const orgId = req.tenant!.org.id;
    if ((await getMode(userId, orgId)) === "off") {
      res.status(403).json({ error: { code: "drive_off", message: "Browser driving is off for this workspace." } });
      return;
    }
    res.json({ ticket: await signTicket(userId, orgId) });
  } catch (err) {
    next(err);
  }
});

// The tab's SSE stream — ticket-authenticated (EventSource can't send a header).
driveRouter.get("/:slug/drive/tab/stream", async (req, res) => {
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  const browserId = typeof req.query.browser_id === "string" ? req.query.browser_id : "";
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
  const who = ticket ? await verifyTicket(ticket) : null;
  if (!who || !browserId) {
    res.status(401).json({ error: { code: "bad_ticket", message: "A valid ticket + browser_id are required." } });
    return;
  }
  if ((await getMode(who.userId, who.orgId)) === "off") {
    res.status(403).json({ error: { code: "drive_off", message: "Browser driving is off for this workspace." } });
    return;
  }
  const { send, stop } = openSse(res);
  const off = driveHub.connectTab(who.userId, who.orgId, browserId, sessionId, send);
  req.on("close", () => {
    stop();
    off();
  });
});

const BrowserIdBody = z.object({ browser_id: z.string().min(1).max(120) });

driveRouter.post("/:slug/drive/tab/accept", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = BrowserIdBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "browser_id required" } });
      return;
    }
    if ((await getMode(req.session!.id, req.tenant!.org.id)) === "off") {
      res.status(403).json({ error: { code: "drive_off", message: "Browser driving is off." } });
      return;
    }
    const ok = driveHub.acceptDrive(req.session!.id, req.tenant!.org.id, parsed.data.browser_id);
    res.json({ ok });
  } catch (err) {
    next(err);
  }
});

driveRouter.post("/:slug/drive/tab/release", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = BrowserIdBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "browser_id required" } });
      return;
    }
    driveHub.releaseDrive(req.session!.id, req.tenant!.org.id, parsed.data.browser_id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const TelemetryBody = z.object({ browser_id: z.string().min(1).max(120), events: z.array(z.unknown()).max(200) });
driveRouter.post("/:slug/drive/tab/telemetry", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = TelemetryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "bad telemetry" } });
      return;
    }
    // Observing requires the stronger grant — never forward actions on navigate-only.
    if ((await getMode(req.session!.id, req.tenant!.org.id)) !== "navigate_observe") {
      res.status(403).json({ error: { code: "observe_off", message: "Observing is off for this workspace." } });
      return;
    }
    driveHub.telemetry(req.session!.id, req.tenant!.org.id, parsed.data.browser_id, parsed.data.events);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── driver side (Claude / MCP — a Bearer-authed Node client) ─────────────────
driveRouter.get("/:slug/drive/driver/stream", requireAuth, withTenant, async (req, res) => {
  const userId = req.session!.id;
  const orgId = req.tenant!.org.id;
  if ((await getMode(userId, orgId)) === "off") {
    res.status(403).json({ error: { code: "drive_off", message: "Browser driving is off for this workspace." } });
    return;
  }
  const { send, stop } = openSse(res);
  const off = driveHub.connectDriver(userId, orgId, send);
  req.on("close", () => {
    stop();
    off();
  });
});

driveRouter.post("/:slug/drive/driver/request", requireAuth, withTenant, async (req, res, next) => {
  try {
    if ((await getMode(req.session!.id, req.tenant!.org.id)) === "off") {
      res.status(403).json({ error: { code: "drive_off", message: "Browser driving is off." } });
      return;
    }
    res.json(driveHub.requestDrive(req.session!.id, req.tenant!.org.id));
  } catch (err) {
    next(err);
  }
});

const NavigateBody = z.object({ path: z.string().min(1).max(2000) });
driveRouter.post("/:slug/drive/driver/navigate", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = NavigateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "path required" } });
      return;
    }
    if ((await getMode(req.session!.id, req.tenant!.org.id)) === "off") {
      res.status(403).json({ error: { code: "drive_off", message: "Browser driving is off." } });
      return;
    }
    // App-relative paths only — never an absolute URL / protocol-relative target.
    const path = parsed.data.path;
    if (!path.startsWith("/") || path.startsWith("//")) {
      res.status(400).json({ error: { code: "bad_path", message: "path must be an app-relative path starting with /" } });
      return;
    }
    const delivered = driveHub.navigate(req.session!.id, req.tenant!.org.id, path);
    res.json({ ok: true, delivered });
  } catch (err) {
    next(err);
  }
});

// Visual presence (Feature 3 polish) — show a cursor / click ripple / element
// highlight on the driven tab so the user can SEE where Claude is pointing.
const PresentBody = z.object({
  selector: z.string().max(400).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  label: z.string().max(120).optional(),
  ripple: z.boolean().optional(),
});
driveRouter.post("/:slug/drive/driver/present", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = PresentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "bad present payload" } });
      return;
    }
    if ((await getMode(req.session!.id, req.tenant!.org.id)) === "off") {
      res.status(403).json({ error: { code: "drive_off", message: "Browser driving is off." } });
      return;
    }
    const delivered = driveHub.present(req.session!.id, req.tenant!.org.id, parsed.data);
    res.json({ ok: true, delivered });
  } catch (err) {
    next(err);
  }
});

// Observe (poll) — drain the buffered user actions. Requires the stronger grant,
// the same as the telemetry SSE push; complements it for a driver that polls.
driveRouter.get("/:slug/drive/driver/observe", requireAuth, withTenant, async (req, res, next) => {
  try {
    if ((await getMode(req.session!.id, req.tenant!.org.id)) !== "navigate_observe") {
      res.status(403).json({ error: { code: "observe_off", message: "Observing is off for this workspace." } });
      return;
    }
    res.json({ events: driveHub.drainTelemetry(req.session!.id, req.tenant!.org.id) });
  } catch (err) {
    next(err);
  }
});

driveRouter.get("/:slug/drive/status", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json(driveHub.status(req.session!.id, req.tenant!.org.id));
  } catch (err) {
    next(err);
  }
});
