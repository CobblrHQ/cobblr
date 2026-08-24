// Workspace calendar — platform-level (like public surfaces), not a module:
// the aggregation + feed are cross-cutting kernel infra, while the dated
// EVENTS are contributed by modules via platform().calendar.registerSource.
//
//   GET  /orgs/:slug/calendar/events?from=&to=   authed — merged events
//   GET  /orgs/:slug/calendar/feed               authed — feed config + URL
//   PUT  /orgs/:slug/calendar/feed               authed (owner/admin) — enable/disable
//   POST /orgs/:slug/calendar/feed/rotate        authed (owner/admin) — new token
//
//   GET  /calendar/:token.ics                    PUBLIC, no auth — iCal feed
//
// The iCal feed doubles as the Google-Calendar integration: paste the .ics
// URL into Google Calendar's "From URL" and it subscribes — no OAuth.

import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import * as calendar from "../platform/calendar-registry.js";
import { buildICS } from "../platform/ical.js";

// ── authed, org-scoped ────────────────────────────────────────────────
export const calendarOrgRouter = Router({ mergeParams: true });

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function shiftISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

calendarOrgRouter.get(
  "/:slug/calendar/events",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const from = typeof req.query.from === "string" ? req.query.from : shiftISO(-31);
      const to = typeof req.query.to === "string" ? req.query.to : shiftISO(366);
      const items = await calendar.collect(req.tenant!.org.id, from, to);
      res.json({ items, from, to });
    } catch (err) {
      next(err);
    }
  },
);

function feedUrl(req: { protocol: string; get(h: string): string | undefined }, token: string): string {
  const host = req.get("host") ?? "localhost";
  return `${req.protocol}://${host}/api/v1/calendar/${token}.ics`;
}

calendarOrgRouter.get(
  "/:slug/calendar/feed",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const row = await meta
        .selectFrom("calendar_feeds")
        .select(["token", "enabled"])
        .where("org_id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      res.json({
        enabled: row?.enabled ?? false,
        token: row?.token ?? null,
        url: row ? feedUrl(req, row.token) : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// AI-REACH: a subscribe-by-link feed of what is in this workspace. The link is
// the credential, and handing one out is a person's decision.
calendarOrgRouter.put(
  "/:slug/calendar/feed",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "enabled required" } });
        return;
      }
      const orgId = req.tenant!.org.id;
      const existing = await meta
        .selectFrom("calendar_feeds")
        .select(["token"])
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      const token = existing?.token ?? newToken();
      await meta
        .insertInto("calendar_feeds")
        .values({ org_id: orgId, token, enabled: parsed.data.enabled })
        .onConflict((oc) =>
          oc.column("org_id").doUpdateSet({ enabled: parsed.data.enabled, updated_at: new Date() }),
        )
        .execute();
      res.json({ enabled: parsed.data.enabled, token, url: feedUrl(req, token) });
    } catch (err) {
      next(err);
    }
  },
);

// AI-REACH: rotating that link REVOKES every calendar already subscribed to it.
// Nothing in the workspace shows that it broke; the phone just stops updating.
calendarOrgRouter.post(
  "/:slug/calendar/feed/rotate",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const orgId = req.tenant!.org.id;
      const token = newToken();
      await meta
        .insertInto("calendar_feeds")
        .values({ org_id: orgId, token, enabled: true })
        .onConflict((oc) =>
          oc.column("org_id").doUpdateSet({ token, updated_at: new Date() }),
        )
        .execute();
      res.json({ token, url: feedUrl(req, token), enabled: true });
    } catch (err) {
      next(err);
    }
  },
);

// ── public, no auth ───────────────────────────────────────────────────
export const calendarPublicRouter = Router();

calendarPublicRouter.get("/:token", async (req, res, next) => {
  try {
    // The handed-out URL ends in `.ics`; the param captures "<token>.ics".
    const token = req.params.token.replace(/\.ics$/i, "");
    const feed = await meta
      .selectFrom("calendar_feeds")
      .select(["org_id", "enabled"])
      .where("token", "=", token)
      .executeTakeFirst();
    if (!feed || !feed.enabled) {
      res.status(404).type("text/plain").send("Calendar feed not found or disabled.");
      return;
    }
    // Look back a month, forward a year — enough for a subscription to show
    // recent history + everything coming up.
    const from = shiftISO(-31);
    const to = shiftISO(366);
    const events = await calendar.collect(feed.org_id, from, to);
    const ics = buildICS(events, { name: "Cobblr" });
    res
      .status(200)
      .type("text/calendar; charset=utf-8")
      .set("Content-Disposition", 'inline; filename="cobblr.ics"')
      .set("Cache-Control", "public, max-age=900")
      .send(ics);
  } catch (err) {
    next(err);
  }
});
