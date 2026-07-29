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

/** A bridge you reach DIRECTLY, derived from the connections that use it.
 *
 *  There is deliberately no bridge table. A connection's base_url already
 *  carries both facts — `http://host:8078/pm240-bridge` is a bridge AND an
 *  instance on it — so the bridge is its ORIGIN, and grouping the connections
 *  by origin is the register. That means no new storage, no migration, and no
 *  second copy of an address that could disagree with the connections actually
 *  using it.
 *
 *  Tunnel bridges are not derived this way: they dial in, so the relay knows
 *  them directly and their base_url is `cobblr-edge://`, which has no host to
 *  group by. */
export interface DirectBridge {
  origin: string;
  /** What to call it: the shared prefix of its connections' labels when there is
   *  one, else the host. Beats showing one arbitrary connection's label. */
  label: string;
  /** How many instances (machines) are configured on it. */
  instances: number;
  /** Whether the connections carry a token. Mixed = some do, some do not, which
   *  is worth surfacing because it means one of them is about to start failing. */
  auth: "token" | "none" | "mixed";
  /** The most recent successful reach FROM COBBLR'S SERVER. Distinct from
   *  whether the BROWSER can reach it — those genuinely differ (a bench on a
   *  tailnet host is reachable by a self-hosted Cobblr and not by a laptop on
   *  another network), and reporting one as the other sends people debugging
   *  the wrong hop. */
  last_ok_at: string | null;
  last_status: string | null;
  connection_ids: string[];
}

export function commonLabel(labels: string[], host: string): string {
  const cleaned = labels.map((l) => l.trim()).filter(Boolean);
  if (cleaned.length === 0) return host;
  if (cleaned.length === 1) return cleaned[0]!;
  // Longest shared word-prefix, so "Bench PM240"/"Bench PM220S" reads "Bench".
  const words = cleaned.map((l) => l.split(/\s+/));
  const out: string[] = [];
  for (let i = 0; i < words[0]!.length; i++) {
    const w = words[0]![i];
    if (words.every((ws) => ws[i] === w)) out.push(w!);
    else break;
  }
  return out.length ? out.join(" ") : host;
}

/** The shape this needs from a connection. Deliberately structural rather than
 *  the store's type: it keeps the derivation a pure function you can test
 *  against real rows without a database, which is the only reason the grouping
 *  rules below are checkable at all. */
export interface ConnLike {
  id: string;
  type: string;
  label?: string | null;
  base_url?: string | null;
  config?: Record<string, unknown> | null;
  /** Whether a credential is stored. Not derivable from `config`. */
  has_credentials?: boolean;
  last_sync_status?: string | null;
  last_sync_at?: string | Date | null;
}

export function deriveDirectBridges(conns: readonly ConnLike[]): DirectBridge[] {
  const byOrigin = new Map<string, ConnLike[]>();
  for (const c of conns) {
    if (c.type !== "edge_adapter") continue;
    const base = String(c.base_url ?? "");
    // cobblr-edge:// is the tunnel form; it has no host to group by and the
    // relay already reports it.
    if (!/^https?:\/\//i.test(base)) continue;
    let origin: string;
    try {
      origin = new URL(base).origin;
    } catch {
      continue;
    }
    const list = byOrigin.get(origin) ?? [];
    list.push(c);
    byOrigin.set(origin, list);
  }

  const out: DirectBridge[] = [];
  for (const [origin, list] of byOrigin) {
    // has_credentials, NOT config.api_key. Credentials live encrypted in their
    // own column, so `config` is empty on a connection that authenticates
    // perfectly well — reading it there reported "no token" for every bridge
    // that had one, including the only one anybody had configured.
    const withTok = list.filter((c) => c.has_credentials === true).length;
    const oks = list
      .map((c) => (c.last_sync_status === "ok" ? c.last_sync_at : null))
      .filter(Boolean)
      .map((d) => new Date(String(d)).getTime())
      .sort((a, b) => b - a);
    out.push({
      origin,
      label: commonLabel(list.map((c) => String(c.label ?? "")), new URL(origin).host),
      instances: list.length,
      auth: withTok === list.length ? "token" : withTok === 0 ? "none" : "mixed",
      last_ok_at: oks.length ? new Date(oks[0]!).toISOString() : null,
      last_status: list.find((c) => c.last_sync_status)?.last_sync_status ?? null,
      connection_ids: list.map((c) => String(c.id)),
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

async function directBridges(orgId: string): Promise<DirectBridge[]> {
  return deriveDirectBridges(
    (await platform().devices.connections().list(orgId)) as unknown as ConnLike[],
  );
}

// GET /bridges — list THIS workspace's edge bridges, for the shared picker and
// the Edge bridges page. TUNNEL bridges dial in and the relay knows them;
// DIRECT bridges are derived from the connections that point at them.
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
  // Separate key rather than merged into `bridges`: they are the same CONCEPT to
  // a user and different DATA to a caller (a tunnel bridge is connected-or-not,
  // a direct one is reachable-or-not and from where). The page presents them as
  // one list; flattening them here would force every caller to re-guess which
  // kind it was holding.
  res.json({ bridges, direct: await directBridges(orgId) });
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
