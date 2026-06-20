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
import { tenantContext } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";

export const edgeRelayRouter = Router({ mergeParams: true });

const POLL_WAIT_MS = 25_000; // long-poll hold before a 204 keep-alive
const STALE_MS = 60_000; // drop a channel whose bridge stopped polling
const DEFAULT_REQ_TIMEOUT_MS = 20_000;

type RelayItem = { id: string; path: string; method: "GET" | "POST"; body?: unknown; instance?: EdgeRequest["instance"] };
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
function ensureOrg(orgId: string): OrgRelay {
  const existing = orgs.get(orgId);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }
  const relay: OrgRelay = { queue: [], pending: new Map(), poller: null, lastSeen: Date.now(), unregister: () => {} };
  // send() (called by the edge_adapter relay closure) enqueues a request + parks
  // a promise; /respond resolves it, or it times out.
  relay.unregister = platform().edge.registerChannel(orgId, (req: EdgeRequest): Promise<EdgeResponse> => {
    return new Promise<EdgeResponse>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        relay.pending.delete(id);
        reject(new Error("edge bridge did not respond in time"));
      }, req.timeoutMs ?? DEFAULT_REQ_TIMEOUT_MS);
      relay.pending.set(id, { resolve, reject, timer });
      const item: RelayItem = { id, path: req.path, method: req.method === "POST" ? "POST" : "GET", body: req.body, ...(req.instance ? { instance: req.instance } : {}) };
      if (relay.poller) {
        const deliver = relay.poller;
        relay.poller = null;
        deliver(item);
      } else {
        relay.queue.push(item);
      }
    });
  });
  orgs.set(orgId, relay);
  return relay;
}

/** Tear down a workspace's channel — bridge gone. Fails any in-flight requests. */
function dropOrg(orgId: string): void {
  const o = orgs.get(orgId);
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
  orgs.delete(orgId);
}

// Reap channels whose bridge stopped polling (crash / network drop), so
// platform().edge.hasChannel goes false and send() errors clearly.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [orgId, o] of orgs) if (now - o.lastSeen > STALE_MS) dropOrg(orgId);
}, 30_000);
reaper.unref?.();

// POST /register — the bridge announces itself (Bearer = a workspace API token).
edgeRelayRouter.post("/register", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  ensureOrg(tenantContext(req).org.id);
  res.json({ ok: true });
}));

// GET /poll — long-poll for the next queued request; 204 keep-alive on timeout.
edgeRelayRouter.get("/poll", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const o = ensureOrg(tenantContext(req).org.id);
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
  const o = orgs.get(tenantContext(req).org.id);
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
  const orgId = tenantContext(req).org.id;
  res.json({ connected: platform().edge.hasChannel(orgId), last_seen: orgs.get(orgId)?.lastSeen ?? null });
}));
