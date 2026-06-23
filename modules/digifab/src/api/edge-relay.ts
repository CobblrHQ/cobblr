// Edge tunnel relay — the cloud side an on-site bridge dials OUT to, so a
// hosted Cobblr (strict egress) can reach a LAN machine WITHOUT ever fetching a
// private IP. The bridge holds a long-poll open; the cloud parks each
// edge-adapter request on a queue and the bridge drains it, runs it against the
// local machine, and posts the result back. Inverts the connection — the agent
// initiates — so there's no SSRF surface and no inbound firewall hole.
//
// Wiring: an edge_adapter connection whose base_url starts with `cobblr-edge://`
// builds a relay closure (buildEdgeRelay) that calls platform().edge.send(orgId,…);
// THIS broker is the registerChannel side that send() reaches. Single-instance
// (the in-memory queue lives on one api process — fine for self-host + the
// single-replica hosted box; a multi-replica deploy needs a shared backplane).
//
//   bridge  ──POST /register──►  cloud   (announce; opens the channel)
//   bridge  ──GET  /poll    ──►  cloud   (long-poll; gets the next request or 204)
//   bridge  ──POST /respond ──►  cloud   (returns {id,status,body})
//   cloud   ──GET  /status  ──►  (is a bridge connected for this workspace?)

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { platform, type EdgeRequest, type EdgeResponse } from "@cobblr/platform-contract";
import type { Request } from "express";
import { tenantContext } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { edgeChannelKey } from "../jobs-core.js";
import { BRIDGE_BUNDLE_VERSION, BRIDGE_BUNDLE_SHA256, bridgeBundleJs } from "../edge-bridge-bundle.js";

// Multi-bridge: a workspace can run more than one bridge (separate sites/VLANs,
// or LightBurn which must run its bridge on the LightBurn PC). Each bridge polls
// with `?bridge=<id>` and gets its own channel; no `bridge` → the workspace's
// default channel, byte-identical to the single-bridge path. The id must match
// the connection's stored bridge (creds.edge.bridge) so send() routes to it.
function channelKeyOf(req: Request): string {
  const b = req.query.bridge;
  return edgeChannelKey(tenantContext(req).org.id, typeof b === "string" && b ? b.slice(0, 60) : null);
}

export const edgeRelayRouter = Router({ mergeParams: true });

const POLL_WAIT_MS = 25_000; // long-poll hold before a 204 keep-alive
const STALE_MS = 60_000; // drop a channel whose bridge stopped polling
const DEFAULT_REQ_TIMEOUT_MS = 20_000;

type RelayItem = { id: string; path: string; method: "GET" | "POST"; body?: unknown; instance?: EdgeRequest["instance"]; source?: EdgeRequest["source"] };
type Pending = { resolve: (r: EdgeResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

interface OrgRelay {
  queue: RelayItem[]; // requests waiting to be polled
  pending: Map<string, Pending>; // id -> awaiting /respond
  poller: ((item: RelayItem | null) => void) | null; // a parked long-poll
  lastSeen: number;
  unregister: () => void;
}

const orgs = new Map<string, OrgRelay>();

/** Get-or-create the per-workspace relay state, registering the edge channel the
 *  first time. Refreshes lastSeen so the reaper knows the bridge is alive. */
function ensureOrg(key: string): OrgRelay {
  const existing = orgs.get(key);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }
  const relay: OrgRelay = { queue: [], pending: new Map(), poller: null, lastSeen: Date.now(), unregister: () => {} };
  // send() (called by the edge_adapter relay closure) enqueues a request + parks
  // a promise; /respond resolves it, or it times out.
  relay.unregister = platform().edge.registerChannel(key, (req: EdgeRequest): Promise<EdgeResponse> => {
    return new Promise<EdgeResponse>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        relay.pending.delete(id);
        reject(new Error("edge bridge did not respond in time"));
      }, req.timeoutMs ?? DEFAULT_REQ_TIMEOUT_MS);
      relay.pending.set(id, { resolve, reject, timer });
      const item: RelayItem = { id, path: req.path, method: req.method === "POST" ? "POST" : "GET", body: req.body, ...(req.instance ? { instance: req.instance } : {}), ...(req.source ? { source: req.source } : {}) };
      if (relay.poller) {
        const deliver = relay.poller;
        relay.poller = null;
        deliver(item);
      } else {
        relay.queue.push(item);
      }
    });
  });
  orgs.set(key, relay);
  return relay;
}

/** Tear down a channel — bridge gone. Fails any in-flight requests. */
function dropOrg(key: string): void {
  const o = orgs.get(key);
  if (!o) return;
  o.unregister();
  for (const p of o.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("edge bridge disconnected"));
  }
  o.pending.clear();
  if (o.poller) {
    const deliver = o.poller;
    o.poller = null;
    deliver(null);
  }
  orgs.delete(key);
}

// Reap channels whose bridge stopped polling (crash / network drop), so
// platform().edge.hasChannel goes false and send() errors clearly.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [key, o] of orgs) if (now - o.lastSeen > STALE_MS) dropOrg(key);
}, 30_000);
reaper.unref?.();

// POST /register — the bridge announces itself (Bearer = a workspace API token).
edgeRelayRouter.post("/register", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  ensureOrg(channelKeyOf(req));
  res.json({ ok: true });
}));

// GET /poll — long-poll for the next queued request; 204 keep-alive on timeout.
edgeRelayRouter.get("/poll", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const o = ensureOrg(channelKeyOf(req));
  const ready = o.queue.shift();
  if (ready) {
    res.json(ready);
    return;
  }
  const item = await new Promise<RelayItem | null>((resolve) => {
    o.poller = resolve;
    const t = setTimeout(() => {
      if (o.poller === resolve) {
        o.poller = null;
        resolve(null);
      }
    }, POLL_WAIT_MS);
    // If the bridge hangs up mid-poll, release the parked resolver.
    req.on("close", () => {
      clearTimeout(t);
      if (o.poller === resolve) {
        o.poller = null;
        resolve(null);
      }
    });
  });
  if (item) res.json(item);
  else res.status(204).end();
}));

// POST /respond — the bridge returns a polled request's result.
const Respond = z.object({ id: z.string().min(1), status: z.number().int(), body: z.unknown().optional() });
edgeRelayRouter.post("/respond", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const o = orgs.get(channelKeyOf(req));
  const parsed = Respond.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_body", message: "id + numeric status required" } });
    return;
  }
  const p = o?.pending.get(parsed.data.id);
  if (p) {
    clearTimeout(p.timer);
    o!.pending.delete(parsed.data.id);
    p.resolve({ status: parsed.data.status, body: parsed.data.body ?? null });
  }
  res.json({ ok: true });
}));

// GET /status — is a bridge connected for this workspace right now?
edgeRelayRouter.get("/status", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const key = channelKeyOf(req);
  res.json({ connected: platform().edge.hasChannel(key), last_seen: orgs.get(key)?.lastSeen ?? null });
}));

// ── Self-update — the bridge fetches its OWN code from here (no Docker registry,
// no PAT). GET /release returns the current version; the loader downloads
// /release/bundle only when its running version differs, verifies the sha256, and
// restarts onto it. See edge-bridge src/loader.ts.
edgeRelayRouter.get("/release", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.set("Cache-Control", "no-store").json({ version: BRIDGE_BUNDLE_VERSION, sha256: BRIDGE_BUNDLE_SHA256 });
}));
edgeRelayRouter.get("/release/bundle", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.set("Content-Type", "application/javascript").set("Cache-Control", "no-store").send(bridgeBundleJs());
}));
