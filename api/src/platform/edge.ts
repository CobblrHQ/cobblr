// Edge channel registry + relay mechanics — the open-core side of the
// edge-bridge seam.
//
// A user-run edge agent dials the cloud and holds a pipe open; consumers (the
// digifab edge_adapter driver, the "Local AI via edge bridge" provider, sync
// connectors) call send() to reach the device — no public URL, no SSRF
// surface, because the cloud never dials inward.
//
// TWO ways a channel comes to exist:
//   · the HTTP long-poll relay below (registerChannel is called internally on
//     the first relayTouch/relayPoll) — the generic /orgs/:slug/edge wire and
//     digifab's legacy /modules/digifab/edge alias are both thin shims over
//     these primitives, so a bridge polling EITHER path lands on the SAME
//     channel and every consumer reaches it;
//   · the hosted socket relay (proprietary overlay), which authenticates a
//     personal AI agent and calls registerChannel() directly with a sender
//     that writes over its socket (keyed by USER id, not org).
//
// In-process Maps — SINGLE-INSTANCE ONLY: the queue lives on whichever api
// process the agent connected to. A multi-replica deployment needs a shared
// backplane (Redis pub/sub or a standalone relay); that swaps THIS file while
// keeping the seam, so consumers + the agent never change.

import { randomUUID } from "node:crypto";
import type {
  EdgeAgentInfo,
  EdgeChannelSender,
  EdgeConsumer,
  EdgeRelayItem,
  EdgeRequest,
  EdgeResponse,
} from "@cobblr/platform-contract";
import { BRIDGE_BUNDLE_VERSION, BRIDGE_BUNDLE_SHA256, bridgeBundleJs } from "./edge-bridge-bundle.js";
import { BRIDGE_LOADER_JS } from "./edge-bridge-loader.js";

const channels = new Map<string, EdgeChannelSender>();

export function registerChannel(orgId: string, send: EdgeChannelSender): () => void {
  channels.set(orgId, send); // newest wins
  return () => {
    // Only clear if still ours — a reconnect may have already replaced it.
    if (channels.get(orgId) === send) channels.delete(orgId);
  };
}

export function hasChannel(orgId: string): boolean {
  return channels.has(orgId);
}

export async function send(orgId: string, req: EdgeRequest): Promise<EdgeResponse> {
  const ch = channels.get(orgId);
  if (!ch) {
    throw new Error(
      `no edge device connected for this workspace — start the Cobblr edge bridge and confirm it's online`,
    );
  }
  return ch(req);
}

// ─────────────────────── HTTP long-poll relay mechanics ───────────────────────
// Moved here from modules/digifab/src/api/edge-relay.ts so the tunnel is a
// kernel capability any module can consume and any router can front. Keys
// follow edgeChannelKey: `orgId` (default bridge) or `orgId::<name>`.

const POLL_WAIT_MS = 25_000; // long-poll hold before a keep-alive null
const STALE_MS = 60_000; // drop a channel whose bridge stopped polling
const DEFAULT_REQ_TIMEOUT_MS = 20_000;

type Pending = { resolve: (r: EdgeResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

interface RelayState {
  queue: EdgeRelayItem[]; // requests waiting to be polled
  pending: Map<string, Pending>; // id -> awaiting respond
  poller: ((item: EdgeRelayItem | null) => void) | null; // a parked long-poll
  lastSeen: number;
  unregister: () => void;
}

const relays = new Map<string, RelayState>();

/** Get-or-create the relay state for a channel key, registering the edge
 *  channel the first time. Refreshes lastSeen so the reaper knows the bridge
 *  is alive. */
function ensureRelay(key: string): RelayState {
  const existing = relays.get(key);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }
  const relay: RelayState = { queue: [], pending: new Map(), poller: null, lastSeen: Date.now(), unregister: () => {} };
  // send() enqueues a request + parks a promise; respond resolves it, or it
  // times out.
  relay.unregister = registerChannel(key, (req: EdgeRequest): Promise<EdgeResponse> => {
    return new Promise<EdgeResponse>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        relay.pending.delete(id);
        reject(new Error("edge bridge did not respond in time"));
      }, req.timeoutMs ?? DEFAULT_REQ_TIMEOUT_MS);
      relay.pending.set(id, { resolve, reject, timer });
      const item: EdgeRelayItem = {
        id,
        path: req.path,
        method: req.method === "POST" ? "POST" : "GET",
        body: req.body,
        ...(req.instance ? { instance: req.instance } : {}),
        ...(req.source ? { source: req.source } : {}),
      };
      if (relay.poller) {
        const deliver = relay.poller;
        relay.poller = null;
        deliver(item);
      } else {
        relay.queue.push(item);
      }
    });
  });
  relays.set(key, relay);
  return relay;
}

/** Tear down a channel — bridge gone. Fails any in-flight requests. */
function dropRelay(key: string): void {
  const o = relays.get(key);
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
  relays.delete(key);
}

// Reap channels whose bridge stopped polling (crash / network drop), so
// hasChannel goes false and send() errors clearly.
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [key, o] of relays) if (now - o.lastSeen > STALE_MS) dropRelay(key);
}, 30_000);
reaper.unref?.();

export function relayTouch(key: string): void {
  ensureRelay(key);
}

export function relayPoll(key: string, opts?: { signal?: AbortSignal }): Promise<EdgeRelayItem | null> {
  const o = ensureRelay(key);
  const ready = o.queue.shift();
  if (ready) return Promise.resolve(ready);
  return new Promise<EdgeRelayItem | null>((resolve) => {
    o.poller = resolve;
    const settle = () => {
      if (o.poller === resolve) {
        o.poller = null;
        resolve(null);
      }
    };
    const t = setTimeout(settle, POLL_WAIT_MS);
    // If the bridge hangs up mid-poll, release the parked resolver.
    opts?.signal?.addEventListener("abort", () => {
      clearTimeout(t);
      settle();
    });
  });
}

export function relayRespond(key: string, r: { id: string; status: number; body?: unknown }): boolean {
  const o = relays.get(key);
  const p = o?.pending.get(r.id);
  if (!p) return false;
  clearTimeout(p.timer);
  o!.pending.delete(r.id);
  p.resolve({ status: r.status, body: r.body ?? null });
  return true;
}

export function relayAgents(orgId: string): EdgeAgentInfo[] {
  const agents: EdgeAgentInfo[] = [];
  for (const [key, o] of relays) {
    if (key !== orgId && !key.startsWith(`${orgId}::`)) continue;
    agents.push({
      bridge: key === orgId ? null : key.slice(orgId.length + 2),
      last_seen_ms: Date.now() - o.lastSeen,
      queued: o.queue.length,
      in_flight: o.pending.size,
      parked: !!o.poller,
    });
  }
  return agents;
}

export function relayInfo(orgId: string, bridge?: string | null): { connected: boolean; last_seen: number | null } {
  const key = bridge ? `${orgId}::${bridge}` : orgId;
  return { connected: hasChannel(key), last_seen: relays.get(key)?.lastSeen ?? null };
}

// ───────────────────────────── Consumer registry ─────────────────────────────
// Modules that can attach things to a bridge declare themselves at api load.
// The Edge-bridges page renders one card per consumer — data-driven, so the
// kernel UI never hardcodes a module.

const consumers: EdgeConsumer[] = [];

export function registerConsumer(c: EdgeConsumer): void {
  const i = consumers.findIndex((x) => x.module === c.module && x.label === c.label);
  if (i >= 0) consumers[i] = c; // idempotent on module reload
  else consumers.push(c);
}

export function listConsumers(): EdgeConsumer[] {
  return [...consumers];
}

// ───────────────────────────── Bridge release ─────────────────────────────
// The self-update artifact: bridges GET /release, compare versions, and pull
// /release/bundle when behind. Kernel-owned so a workspace can install a
// bridge before enabling any consumer module.

export function getRelease(): { version: string; sha256: string } {
  return { version: BRIDGE_BUNDLE_VERSION, sha256: BRIDGE_BUNDLE_SHA256 };
}

export function getReleaseBundle(): string {
  return bridgeBundleJs().toString("utf8");
}

/** The registry-free bootstrap loader — a stock node image wgets this and runs
 *  it; it pulls + verifies the bundle above and keeps itself updated. */
export function getReleaseLoader(): string {
  return BRIDGE_LOADER_JS;
}
