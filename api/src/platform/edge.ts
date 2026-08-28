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
// Presence + request routing are SHARED, in cobblr_meta — any api process can
// serve any bridge, so a container swap or a second replica no longer strands
// one. See the backplane section below. An in-process sender may still be
// registered (registerChannel) for a transport that is genuinely local to this
// process, such as an open socket; send() prefers it and falls back to the
// shared relay.

import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
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

// The parameter is a CHANNEL KEY, not an org id, and the difference matters
// every time someone debugs this. edgeChannelKey/edgeKeyFor derives it:
//
//   personal AI connection  → the OWNER'S USER ID   (one bridge, all their
//                             workspaces — no workspace is involved at all)
//   workspace provider      → `<orgId>` or `<orgId>::<name>`
//
// It used to be called `orgId` here, and the not-connected error said "for this
// workspace". Both are wrong for the personal case, which is the common one, and
// they are wrong in the direction that costs the most: a reader is told a
// workspace is the routing identity, goes looking at workspace configuration,
// and finds nothing amiss because nothing is. That happened twice in one
// session, from the same two strings (2026-08-18). Say "channel", print the key,
// and let the caller name what kind it is.
function connectedChannels(): string {
  const known = [...channels.keys()];
  return known.length
    ? `channels connected to this api process: ${known.map((k) => k.slice(0, 8) + "…").join(", ")}`
    : "no bridge is connected to THIS api process at all (the registry is per-process, so a container that was just replaced starts empty until the bridge re-polls)";
}

export function registerChannel(key: string, send: EdgeChannelSender): () => void {
  channels.set(key, send); // newest wins
  return () => {
    // Only clear if still ours — a reconnect may have already replaced it.
    if (channels.get(key) === send) channels.delete(key);
  };
}

export async function hasChannel(key: string): Promise<boolean> {
  if (channels.has(key)) return true;
  return bridgeIsFresh(key);
}

export async function send(key: string, req: EdgeRequest): Promise<EdgeResponse> {
  // A locally-registered sender owns a transport this process holds open, so
  // it is both faster and the only one that can serve it.
  const ch = channels.get(key);
  if (ch) return ch(req);

  if (await bridgeIsFresh(key)) return relaySend(key, req);
  {
    // Name the CHANNEL, never "this workspace": a personal bridge is keyed by
    // user id and has no workspace, so blaming one sends the reader to a
    // setting that was never involved.
    throw new Error(
      `no edge bridge is connected on channel ${key.slice(0, 8)}… — a PERSONAL AI connection routes by your user id (not by workspace), so check that the Cobblr edge bridge is running and signed in as the same user. ${connectedChannels()}`,
    );
  }
}

/** Hand a request to whichever process is holding this bridge's poll, and wait
 *  for the response it writes back. Neither side needs to be this process. */
async function relaySend(key: string, req: EdgeRequest): Promise<EdgeResponse> {
  const id = randomUUID();
  const timeoutMs = req.timeoutMs ?? DEFAULT_REQ_TIMEOUT_MS;
  const expires = new Date(Date.now() + timeoutMs);
  await meta
    .insertInto("edge_relay_jobs")
    .values({ id, channel_key: key, request: JSON.stringify(req), expires_at: expires })
    .execute();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await meta
      .selectFrom("edge_relay_jobs")
      .select(["status", "response"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (row?.status === "done") {
      const r = row.response as { status?: number; body?: unknown } | null;
      return { status: r?.status ?? 502, body: r?.body ?? null };
    }
    if (Date.now() >= deadline) {
      await meta.deleteFrom("edge_relay_jobs").where("id", "=", id).execute().catch(() => {});
      throw new Error("edge bridge did not respond in time");
    }
    await sleep(CLAIM_POLL_MS);
  }
}

// ─────────────────────── Relay backplane (shared, in Postgres) ───────────────
// Presence and request routing live in cobblr_meta, NOT in this process.
//
// They used to be two Maps here. That made the bridge reachable only from the
// one api process its long-poll happened to land on: a replaced container
// started empty until the bridge re-polled, and during a blue-green overlap both
// containers sat in the load balancer while the bridge was registered on exactly
// one — so requests alternated between working and "no edge device connected",
// which is precisely what a user reported as "got one reply, failed next"
// (2026-08-18). It also capped the api at one replica for reasons that had
// nothing to do with deploys.
//
// Postgres rather than Redis on purpose: it is already a hard dependency and
// already the coordination substrate (platform/queue.ts claims work with
// SELECT … FOR UPDATE SKIP LOCKED). Adding Redis would tax every self-hoster to
// solve a problem the database we mandate already solves.
//
// Waiters poll at CLAIM_POLL_MS rather than using LISTEN/NOTIFY. A quarter
// second is imperceptible against payloads that take seconds to minutes, and it
// costs no dedicated connection and no behaviour change behind a transaction
// pooler. If a latency-sensitive consumer ever appears, NOTIFY drops in behind
// this same seam.

const POLL_WAIT_MS = 25_000; // long-poll hold before a keep-alive null
const PRESENCE_FRESH_MS = 60_000; // a bridge unheard-from this long is gone
const CLAIM_POLL_MS = 250; // how often a parked poll / waiter re-checks
const DEFAULT_REQ_TIMEOUT_MS = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Record that a bridge is polling for this channel, right now. */
export async function relayTouch(key: string): Promise<void> {
  await meta
    .insertInto("edge_bridges")
    .values({ channel_key: key })
    .onConflict((oc) => oc.column("channel_key").doUpdateSet({ last_seen: new Date() }))
    .execute();
}

/** Has a bridge been heard from recently, on ANY api process? */
async function bridgeIsFresh(key: string): Promise<boolean> {
  const row = await meta
    .selectFrom("edge_bridges")
    .select("last_seen")
    .where("channel_key", "=", key)
    .executeTakeFirst();
  if (!row) return false;
  return Date.now() - new Date(row.last_seen).getTime() < PRESENCE_FRESH_MS;
}

/** Claim the oldest queued job for this channel, or null.
 *  SKIP LOCKED so two processes polling the same channel cannot take the same
 *  row — the pattern platform/queue.ts already relies on. */
async function claimNext(key: string): Promise<EdgeRelayItem | null> {
  const rows = await sql<{ id: string; request: EdgeRequest }>`
    UPDATE edge_relay_jobs SET status = 'claimed', claimed_at = now()
     WHERE id = (
       SELECT id FROM edge_relay_jobs
        WHERE channel_key = ${key} AND status = 'queued' AND expires_at > now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id, request
  `.execute(meta);
  const row = rows.rows[0];
  if (!row) return null;
  const req = row.request;
  return {
    id: row.id,
    path: req.path,
    method: req.method === "POST" ? "POST" : "GET",
    body: req.body,
    ...(req.instance ? { instance: req.instance } : {}),
    ...(req.source ? { source: req.source } : {}),
  };
}

export async function relayPoll(key: string, opts?: { signal?: AbortSignal }): Promise<EdgeRelayItem | null> {
  await relayTouch(key);
  const deadline = Date.now() + POLL_WAIT_MS;
  for (;;) {
    const item = await claimNext(key);
    if (item) return item;
    if (opts?.signal?.aborted || Date.now() >= deadline) return null;
    await sleep(CLAIM_POLL_MS);
    // Keep presence warm across a long park, or the reaper would call a bridge
    // that is sitting right here "disconnected".
    if (Date.now() % 10_000 < CLAIM_POLL_MS) await relayTouch(key);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function relayRespond(
  key: string,
  r: { id: string; status: number; body?: unknown },
): Promise<boolean> {
  // A bridge that retried late answers an id that is gone, and a confused one
  // answers something that was never an id at all. The column is uuid, so
  // handing that straight to Postgres throws — and in an async route with no
  // catch that leaves the request hanging rather than failing. Not-a-uuid is
  // simply "no such job".
  if (!UUID_RE.test(r.id)) return false;
  const res = await meta
    .updateTable("edge_relay_jobs")
    .set({ status: "done", done_at: new Date(), response: JSON.stringify({ status: r.status, body: r.body ?? null }) })
    .where("id", "=", r.id)
    .where("channel_key", "=", key)
    .where("status", "=", "claimed")
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

export async function relayAgents(orgId: string): Promise<EdgeAgentInfo[]> {
  const rows = await meta
    .selectFrom("edge_bridges")
    .select(["channel_key", "last_seen"])
    .where((eb) => eb.or([eb("channel_key", "=", orgId), eb("channel_key", "like", `${orgId}::%`)]))
    .execute();
  const out: EdgeAgentInfo[] = [];
  for (const row of rows) {
    const age = Date.now() - new Date(row.last_seen).getTime();
    if (age > PRESENCE_FRESH_MS) continue;
    const counts = await meta
      .selectFrom("edge_relay_jobs")
      .select(({ fn }) => [fn.countAll<string>().as("n")])
      .where("channel_key", "=", row.channel_key)
      .where("status", "=", "queued")
      .executeTakeFirst();
    out.push({
      bridge: row.channel_key === orgId ? null : row.channel_key.slice(orgId.length + 2),
      last_seen_ms: age,
      queued: Number(counts?.n ?? 0),
      in_flight: 0,
      parked: true,
    });
  }
  return out;
}

export async function relayInfo(
  orgId: string,
  bridge?: string | null,
): Promise<{ connected: boolean; last_seen: number | null }> {
  const key = bridge ? `${orgId}::${bridge}` : orgId;
  const row = await meta
    .selectFrom("edge_bridges")
    .select("last_seen")
    .where("channel_key", "=", key)
    .executeTakeFirst();
  const age = row ? Date.now() - new Date(row.last_seen).getTime() : null;
  return { connected: age !== null && age < PRESENCE_FRESH_MS, last_seen: age };
}

// Remove finished and abandoned rows. A waiter has already given up by
// expires_at, so nothing is lost.
// SINGLE-PROCESS-SAFE: an idempotent DELETE of rows already past their
// expiry — running it in two processes removes the same rows, which is the
// same outcome as running it in one.
const sweeper = setInterval(() => {
  void meta
    .deleteFrom("edge_relay_jobs")
    .where((eb) => eb.or([eb("expires_at", "<", new Date()), eb("status", "=", "done")]))
    .where("created_at", "<", new Date(Date.now() - 60_000))
    .execute()
    .catch(() => {});
}, 60_000);
sweeper.unref?.();

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
