// Edge tunnel relay — LEGACY ALIAS. The relay itself (queue mechanics, channel
// registry, pane of glass, self-update release) is a KERNEL capability now —
// platform().edge / /orgs/:slug/edge — because a bridge is generic
// infrastructure that many modules consume (digifab machine managers, AI,
// sync connectors). See api/src/routes/edge.ts + api/src/platform/edge.ts.
//
// These routes stay because bridges in the field were installed with
// BRIDGE_RELAY_URL=…/modules/digifab/edge and poll it forever. They are thin
// shims over the same platform().edge primitives, so a bridge polling here
// lands on the SAME channel as one polling the kernel wire — consumers can't
// tell the difference, and old bridges self-update without a reinstall.
//
//   bridge  ──POST /register──►  cloud   (announce; opens the channel)
//   bridge  ──GET  /poll    ──►  cloud   (long-poll; next request or 204)
//   bridge  ──POST /respond ──►  cloud   (returns {id,status,body})
//   ui      ──GET  /status  ──►  (is a bridge connected for this workspace?)

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { Request } from "express";
import { tenantContext } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { edgeChannelKey } from "../jobs-core.js";

// Multi-bridge: a workspace can run more than one bridge (separate sites/VLANs,
// or LightBurn which must run its bridge on the LightBurn PC). Each bridge polls
// with `?bridge=<id>` and gets its own channel; no `bridge` → the workspace's
// default channel. The id must match the connection's stored bridge
// (creds.edge.bridge) so send() routes to it.
function channelKeyOf(req: Request): string {
  const b = req.query.bridge;
  return edgeChannelKey(tenantContext(req).org.id, typeof b === "string" && b ? b.slice(0, 60) : null);
}

function bridgeOf(req: Request): string | null {
  const b = req.query.bridge;
  return typeof b === "string" && b ? b.slice(0, 60) : null;
}

export const edgeRelayRouter = Router({ mergeParams: true });

// POST /register — the bridge announces itself (Bearer = a workspace API token).
edgeRelayRouter.post("/register", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  platform().edge.relayTouch(channelKeyOf(req));
  res.json({ ok: true });
}));

// GET /poll — long-poll for the next queued request; 204 keep-alive on timeout.
edgeRelayRouter.get("/poll", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const item = await platform().edge.relayPoll(channelKeyOf(req), { signal: ac.signal });
  if (item) res.json(item);
  else res.status(204).end();
}));

// POST /respond — the bridge returns a polled request's result.
const Respond = z.object({ id: z.string().min(1), status: z.number().int(), body: z.unknown().optional() });
edgeRelayRouter.post("/respond", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const parsed = Respond.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_body", message: "id + numeric status required" } });
    return;
  }
  platform().edge.relayRespond(channelKeyOf(req), parsed.data);
  res.json({ ok: true });
}));

// GET /status — is a bridge connected for this workspace right now?
// (The EdgeBridgeSetup dialog polls this while waiting for the box to dial in.)
edgeRelayRouter.get("/status", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.json(platform().edge.relayInfo(tenantContext(req).org.id, bridgeOf(req)));
}));

// GET /bridges — list THIS workspace's connected edge bridges (default + named),
// for the shared bridge picker.
edgeRelayRouter.get("/bridges", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const orgId = tenantContext(req).org.id;
  const bridges = platform()
    .edge.relayAgents(orgId)
    .map((a) => ({
      bridge: a.bridge,
      connected: platform().edge.hasChannel(edgeChannelKey(orgId, a.bridge)),
      last_seen: Date.now() - a.last_seen_ms,
    }));
  // Default first, then named bridges alphabetically.
  bridges.sort((a, b) =>
    a.bridge === null ? -1 : b.bridge === null ? 1 : a.bridge.localeCompare(b.bridge),
  );
  res.json({ bridges });
}));

// ── Self-update — the bridge fetches its OWN code from here. The artifact is
// kernel-owned; these aliases keep pre-move bridges updating.
edgeRelayRouter.get("/release", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.set("Cache-Control", "no-store").json(platform().edge.getRelease());
}));
edgeRelayRouter.get("/release/bundle", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.set("Content-Type", "application/javascript").set("Cache-Control", "no-store").send(platform().edge.getReleaseBundle());
}));
