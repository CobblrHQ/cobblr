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
import { EdgeOffline, EdgeTimeout, EdgeUnsupported } from "@cobblr/platform-contract";
import type {
  EdgeAgentInfo,
  EdgeBridgeRecord,
  EdgeChannelSender,
  EdgeConsumer,
  EdgeFetchInit,
  EdgeLane,
  EdgeMethod,
  EdgeRelayItem,
  EdgeRequest,
  EdgeResponse,
} from "@cobblr/platform-contract";
import { bridgeDisplayName, bridgeNameFromToken, edgeChannelKey, edgeLaneOf } from "@cobblr/platform-contract/edge-channel";
import { BRIDGE_BUNDLE_VERSION, BRIDGE_BUNDLE_SHA256, bridgeBundleJs } from "./edge-bridge-bundle.js";
import { blobExpect, blobOffer, blobReceived, blobRelease } from "./edge-blobs.js";
import { createReadStream } from "node:fs";
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

// Who wants to know when a bridge comes back: a connection that rides it was
// tested while it was away and still says so, until somebody presses Test.
type OnlineListener = (key: string) => void;
const onlineListeners: OnlineListener[] = [];

/** Be told when a bridge that was away (or never seen) is heard from. Fires
 *  in the process that heard it, once per return, not on every poll. */
export function onBridgeOnline(fn: OnlineListener): () => void {
  onlineListeners.push(fn);
  return () => {
    const i = onlineListeners.indexOf(fn);
    if (i >= 0) onlineListeners.splice(i, 1);
  };
}

function cameOnline(key: string): void {
  for (const fn of onlineListeners) {
    try {
      fn(key);
    } catch (err) {
      console.warn(`[edge] online listener failed for ${key.slice(0, 8)}…: ${(err as Error).message}`);
    }
  }
}

/** Was a bridge last heard from so long ago (or never) that hearing it now is
 *  a return? */
export function isReturn(lastSeen: Date | null, now: number = Date.now()): boolean {
  return !lastSeen || now - lastSeen.getTime() >= PRESENCE_FRESH_MS;
}

export function registerChannel(key: string, send: EdgeChannelSender): () => void {
  const fresh = !channels.has(key);
  channels.set(key, send); // newest wins
  if (fresh) cameOnline(key);
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
  if (req.privacy === "personal" && req.bodyFile) throw privateTransitUnavailable(key);
  if (req.bodyFile) {
    // The file goes on the blob channel; the relayed call carries only its id.
    const { bodyFile, ...rest } = req;
    await requireFeature(key, "blobs");
    const id = await blobOffer(key, bodyFile);
    try {
      return await sendOne(key, { ...rest, blob: { id, direction: "down", sha256: bodyFile.sha256.toLowerCase(), size: bodyFile.size } });
    } finally {
      await blobRelease(id).catch(() => {});
    }
  }
  return sendOne(key, req);
}

async function sendOne(key: string, req: EdgeRequest): Promise<EdgeResponse> {
  // A locally-registered sender owns a transport this process holds open, so
  // it is both faster and the only one that can serve it.
  const ch = channels.get(key);
  if (ch) return ch(req);
  if (req.privacy === "personal") throw privateTransitUnavailable(key);

  if (await bridgeIsFresh(key)) return relaySend(key, req);
  // The operator's diagnosis goes to the log; the person gets a sentence about
  // their bridge, by its name, and what to do.
  console.warn(`[edge] send on ${key.slice(0, 8)}… found no bridge; ${connectedChannels()}`);
  throw new EdgeOffline(key, await offlineReason(key));
}

const EDGE_METHODS: readonly EdgeMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
/** A bridge answers a poll gap within about this long. */
const RECONNECT_GRACE_MS = 1_500;

/** Fetch-shaped call performed by a bridge on its network. One copy for every
 *  module (it used to be private in the AI and the shipments transits, each
 *  retrying on a text match of an error message). */
export async function fetchViaEdge(key: string, init: EdgeFetchInit): Promise<Response> {
  if (init.privacy === "personal" && (init.bodyFile || init.download)) throw privateTransitUnavailable(key);
  for (const feature of init.requiredFeatures ?? []) await requireFeature(key, feature);
  const moving = !!init.bodyFile || !!init.download;
  if (init.download) await requireFeature(key, "blobs");
  // A body file is offered by send(); only a download is set up here.
  const blob = init.download ? { id: await blobExpect(key), direction: "up" as const } : undefined;
  const req: EdgeRequest = {
    ...(init.privacy ? { privacy: init.privacy } : {}),
    path: init.path,
    method: init.method ?? (init.bodyFile ? "PUT" : "GET"),
    ...(init.body !== undefined && init.body !== null && !init.bodyFile ? { body: init.body } : {}),
    source: { baseUrl: init.baseUrl.replace(/\/+$/, ""), headers: init.headers ?? {} },
    // A file hop's budget is the transfer's, not a status read's.
    ...(init.timeoutMs || moving ? { timeoutMs: init.timeoutMs ?? FILE_HOP_MS } : {}),
    lane: init.lane ?? "service",
    scope: originOf(init.baseUrl),
    ...(blob ? { blob } : {}),
    ...(init.bodyFile ? { bodyFile: init.bodyFile } : {}),
  };
  let res: EdgeResponse;
  try {
    try {
      res = await send(key, req);
    } catch (err) {
      // Between two long-polls a bridge holds no poll for a moment; the one
      // retry covers that gap. Anything else is the answer.
      if (!(err instanceof EdgeOffline)) throw err;
      await sleep(RECONNECT_GRACE_MS);
      res = await send(key, req);
    }
  } catch (err) {
    if (blob) await blobRelease(blob.id).catch(() => {});
    throw err;
  }
  if (blob?.direction === "up") {
    const said = (res.body as { __blob?: { id?: string; sha256?: string; size?: number } } | null)?.__blob;
    if (!said) {
      // The service answered with an error, not a file: that answer is the result.
      await blobRelease(blob.id).catch(() => {});
      return toResponse(res, req.method === "HEAD");
    }
    const got = await blobReceived(key, blob.id);
    if (!got || said.id !== blob.id || said.sha256?.toLowerCase() !== got.sha256) {
      await blobRelease(blob.id).catch(() => {});
      return toResponse({ status: 502, body: { error: { code: "edge_blob", message: "The file the bridge reported is not the file Cobblr received, so it was not used." } } });
    }
    const headers = new Headers(res.headers ?? {});
    headers.set("content-length", String(got.size));
    headers.set("x-cobblr-sha256", got.sha256);
    if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
    return new Response(pulledFrom(got.path, () => void blobRelease(blob.id).catch(() => {})), { status: res.status || 200, headers });
  }
  return toResponse(res, req.method === "HEAD");
}

/** A file as a Response body, read only as fast as the caller reads it.
 *  Readable.toWeb reads a Node stream ahead with no backpressure (a 100 MB file
 *  held whole, measured on the bridge side), so this pulls one chunk per read. */
function pulledFrom(path: string, done: () => void): ReadableStream<Uint8Array> {
  const it = createReadStream(path)[Symbol.asyncIterator]();
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      done();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const r = await it.next();
      if (r.done) {
        ctrl.close();
        finish();
      } else ctrl.enqueue(new Uint8Array(r.value as Buffer));
    },
    async cancel() {
      await it.return?.();
      finish();
    },
  });
}

/** How long one file hop may take by default. */
const FILE_HOP_MS = 30 * 60_000;

function privateTransitUnavailable(key: string): EdgeUnsupported {
  return new EdgeUnsupported(key, "private-transit", "This bridge cannot safely read personal documents yet. Use a local model on this server.");
}

/** Refuse a call the bridge on `key` has not said it can make, in words and by
 *  type, so a caller with an older way to do it can fall back. */
async function requireFeature(key: string, feature: string): Promise<void> {
  const row = await meta.selectFrom("edge_bridges").select(["features"]).where("channel_key", "=", key).executeTakeFirst();
  const has = Array.isArray(row?.features) && (row!.features as string[]).includes(feature);
  if (!has) {
    const w = await workspaceBridge(key).catch(() => null);
    const who = w?.last_seen ? `Your bridge “${bridgeDisplayName(w)}”` : "Your edge bridge";
    const reason = feature === "no-redirects" ? "cannot safely read personal documents yet" : "is too old to carry files";
    throw new EdgeUnsupported(key, feature, `${who} ${reason}. Bridges update themselves within about half an hour; try again after that.`);
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** An EdgeResponse as a fetch Response. A binary body rides the JSON relay as
 *  { __binary, contentType, data_b64 }; a string is text; anything else JSON. */
export function toResponse(res: EdgeResponse, head = false): Response {
  const status = res.status && res.status >= 200 && res.status <= 599 ? res.status : 502;
  const headers = new Headers(res.headers ?? {});
  const empty = head || status === 204 || status === 304;
  const b = res.body as { __binary?: boolean; contentType?: string; data_b64?: string } | null;
  if (empty) return new Response(null, { status, headers });
  if (b && typeof b === "object" && b.__binary === true && typeof b.data_b64 === "string") {
    headers.set("content-type", b.contentType || headers.get("content-type") || "application/octet-stream");
    headers.delete("content-length");
    return new Response(Uint8Array.from(Buffer.from(b.data_b64, "base64")), { status, headers });
  }
  // The relay re-encodes the body, so the service's own length no longer holds.
  headers.delete("content-length");
  if (typeof res.body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(res.body, { status, headers });
  }
  // Every relay caller used to read an empty answer as JSON null; a service
  // that named its type keeps it.
  if (res.body === null || res.body === undefined) {
    if (headers.has("content-type")) return new Response(null, { status, headers });
    headers.set("content-type", "application/json");
    return new Response("null", { status, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(res.body), { status, headers });
}

/** How long ago, in words a person reads: "4 minutes", "3 hours", "2 days". */
export function howLongAgo(then: Date, now: Date = new Date()): string {
  const m = Math.max(1, Math.round((now.getTime() - then.getTime()) / 60_000));
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** Who a channel key belongs to. A key is `<orgId>::<bridge>` (a named
 *  workspace bridge), `<orgId>` (the workspace's default) or `<userId>` (a
 *  person's own bridge). A key whose workspace is gone belongs to nobody:
 *  it is never read as a person's, which is what a deleted workspace's key
 *  used to be told ("your personal edge bridge", #4331). */
type BridgeOwner =
  | { kind: "workspace"; bridge: string | null; name: string | null; last_seen: Date | null }
  | { kind: "person" }
  | { kind: "gone" };

async function bridgeOwner(key: string): Promise<BridgeOwner> {
  const i = key.indexOf("::");
  const orgId = i < 0 ? key : key.slice(0, i);
  const org = await meta
    .selectFrom("orgs")
    .select("id")
    .where(sql<string>`id::text`, "=", orgId)
    .executeTakeFirst();
  if (org) {
    const row = await meta
      .selectFrom("edge_bridges")
      .select(["name", "last_seen"])
      .where("channel_key", "=", key)
      .executeTakeFirst();
    return { kind: "workspace", bridge: i < 0 ? null : key.slice(i + 2), name: row?.name ?? null, last_seen: row ? new Date(row.last_seen) : null };
  }
  if (i >= 0) return { kind: "gone" };
  const user = await meta
    .selectFrom("users")
    .select("id")
    .where(sql<string>`id::text`, "=", key)
    .executeTakeFirst();
  return user ? { kind: "person" } : { kind: "gone" };
}

async function workspaceBridge(key: string): Promise<{ bridge: string | null; name: string | null; last_seen: Date | null } | null> {
  const o = await bridgeOwner(key);
  return o.kind === "workspace" ? o : null;
}

/** Why a send found nobody, said to the person who pressed the button. */
export async function offlineReason(key: string): Promise<string> {
  let o: BridgeOwner;
  try {
    o = await bridgeOwner(key);
  } catch {
    // Could not ask. Saying whose bridge it is would be a guess.
    return "Your edge bridge did not answer, and Cobblr could not check why just now. Try again in a minute.";
  }
  if (o.kind === "person") {
    return "Your personal edge bridge is not connected. Check that the Cobblr edge bridge on your computer is running and signed in as you, then try again.";
  }
  if (o.kind === "gone") {
    return "There is no bridge to send to: the workspace or person it belonged to no longer exists.";
  }
  const name = bridgeDisplayName(o);
  if (!o.last_seen) {
    return o.bridge === null
      ? "This workspace has no bridge yet. Set one up under Configuration → Devices, then try again."
      : `This workspace has no bridge called “${o.bridge}”. Check the name, or set it up under Configuration → Devices.`;
  }
  return `Your bridge “${name}” is offline. It was last heard from ${howLongAgo(o.last_seen)} ago. Check that the box it runs on has power and a network connection, then try again.`;
}

/** Hand a request to whichever process is holding this bridge's poll, and wait
 *  for the response it writes back. Neither side needs to be this process. */
async function relaySend(key: string, req: EdgeRequest): Promise<EdgeResponse> {
  const id = randomUUID();
  const timeoutMs = req.timeoutMs ?? DEFAULT_REQ_TIMEOUT_MS;
  const expires = new Date(Date.now() + timeoutMs);
  const lane = edgeLaneOf(req);
  const scope = req.scope ?? (req.source ? originOf(req.source.baseUrl) : undefined);
  await meta
    .insertInto("edge_relay_jobs")
    .values({ id, channel_key: key, request: JSON.stringify({ ...req, lane, ...(scope ? { scope } : {}) }), expires_at: expires, lane })
    .execute();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await meta
      .selectFrom("edge_relay_jobs")
      .select(["status", "response"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (row?.status === "done") {
      const r = row.response as { status?: number; body?: unknown; headers?: Record<string, string> } | null;
      return { status: r?.status ?? 502, body: r?.body ?? null, ...(r?.headers ? { headers: r.headers } : {}) };
    }
    if (Date.now() >= deadline) {
      await meta.deleteFrom("edge_relay_jobs").where("id", "=", id).execute().catch(() => {});
      const w = await workspaceBridge(key).catch(() => null);
      const who = w ? `Your bridge “${bridgeDisplayName(w)}”` : "Your edge bridge";
      throw new EdgeTimeout(
        key,
        `${who} is online but did not answer within ${Math.round(timeoutMs / 1000)} seconds. The device behind it may be off or busy.`,
      );
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

/** Record that a bridge is polling for this channel, right now, and, when it
 *  registers, what it says about itself. The name is taken ONCE, from the
 *  token it was installed with (the name typed on the setup screen), so a
 *  rename afterwards is never undone by the next registration. */
export async function relayTouch(key: string, report?: BridgeReport): Promise<void> {
  const clip = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
  let name: string | null = null;
  if (report?.tokenId) {
    const tok = await meta.selectFrom("api_tokens").select("name").where("id", "=", report.tokenId).executeTakeFirst();
    name = clip(bridgeNameFromToken(tok?.name));
  }
  const version = clip(report?.version);
  const hostname = clip(report?.hostname);
  // An older bridge says nothing about a list: keep what is known. A bridge
  // that says null has had its list removed.
  const saysAllow = report !== undefined && "allow" in report;
  const allow = Array.isArray(report?.allow)
    ? report!.allow.filter((e): e is string => typeof e === "string" && !!e.trim()).slice(0, 50).map((e) => e.trim().slice(0, 100))
    : null;
  const saysFeatures = report !== undefined && "features" in report;
  const features = Array.isArray(report?.features) ? report!.features.filter((f): f is string => typeof f === "string").slice(0, 32) : null;
  const before = await meta.selectFrom("edge_bridges").select("last_seen").where("channel_key", "=", key).executeTakeFirst();
  await meta
    .insertInto("edge_bridges")
    .values({
      channel_key: key,
      name,
      version,
      hostname,
      token_id: report?.tokenId ?? null,
      allowlist: saysAllow && allow?.length ? (JSON.stringify(allow) as never) : null,
      features: saysFeatures && features ? (JSON.stringify(features) as never) : null,
    })
    .onConflict((oc) =>
      oc.column("channel_key").doUpdateSet({
        last_seen: new Date(),
        // Keep what is known; a plain poll reports nothing and must not blank it.
        name: sql`coalesce(edge_bridges.name, excluded.name)`,
        version: sql`coalesce(excluded.version, edge_bridges.version)`,
        hostname: sql`coalesce(excluded.hostname, edge_bridges.hostname)`,
        token_id: sql`coalesce(excluded.token_id, edge_bridges.token_id)`,
        ...(saysAllow ? { allowlist: sql`excluded.allowlist` } : {}),
        // A register says what the running bridge can do now; an update may
        // have added or dropped something, so it replaces, never merges.
        ...(saysFeatures ? { features: sql`excluded.features` } : {}),
      }),
    )
    .execute();
  if (isReturn(before ? new Date(before.last_seen) : null)) cameOnline(key);
}

/** What a bridge says about itself when it registers. `tokenId` is the API
 *  token it authenticated with; its name becomes the bridge's first name.
 *  `allow` is present only when the bridge reports its list (null: none). */
export interface BridgeReport {
  version?: string | null;
  hostname?: string | null;
  tokenId?: string | null;
  allow?: string[] | null;
  features?: string[] | null;
}

/** Cut a bridge off: revoke the key it registers with, so its next check-in is
 *  refused, and take it off the list. Returns null when the workspace has no
 *  such bridge, else the names of any other bridges that shared the key and
 *  are cut off with it. */
export async function disconnectBridge(orgId: string, bridge: string | null): Promise<{ alsoCut: string[] } | null> {
  const key = edgeChannelKey(orgId, bridge);
  const row = await meta.selectFrom("edge_bridges").select(["token_id"]).where("channel_key", "=", key).executeTakeFirst();
  if (!row) return null;
  let alsoCut: string[] = [];
  if (row.token_id) {
    await meta.updateTable("api_tokens").set({ revoked_at: new Date() }).where("id", "=", row.token_id).where("revoked_at", "is", null).execute();
    const others = await meta
      .selectFrom("edge_bridges")
      .select(["channel_key", "name"])
      .where("token_id", "=", row.token_id)
      .where("channel_key", "!=", key)
      .execute();
    alsoCut = others.map((o) => {
      const i = o.channel_key.indexOf("::");
      return bridgeDisplayName({ bridge: i < 0 ? null : o.channel_key.slice(i + 2), name: o.name });
    });
  }
  await meta.deleteFrom("edge_relay_jobs").where("channel_key", "=", key).execute();
  await meta.deleteFrom("edge_bridges").where("channel_key", "=", key).execute();
  return { alsoCut };
}

/** Every bridge this workspace has, online or not, with what a person needs
 *  to recognise it. Offline ones are listed too: a bridge that stopped is
 *  exactly the one somebody is looking for. */
export async function listBridges(orgId: string): Promise<EdgeBridgeRecord[]> {
  const rows = await meta
    .selectFrom("edge_bridges")
    .select(["channel_key", "last_seen", "first_seen", "name", "version", "hostname", "allowlist", "token_id"])
    .where((eb) => eb.or([eb("channel_key", "=", orgId), eb("channel_key", "like", `${orgId}::%`)]))
    .execute();
  const out = rows.map((r) => {
    const age = Date.now() - new Date(r.last_seen).getTime();
    return {
      bridge: r.channel_key === orgId ? null : r.channel_key.slice(orgId.length + 2),
      name: r.name,
      // Fresh in the shared table, or held open in THIS process (a socket).
      connected: age < PRESENCE_FRESH_MS || channels.has(r.channel_key),
      last_seen: new Date(r.last_seen).toISOString(),
      first_seen: new Date(r.first_seen).toISOString(),
      version: r.version,
      hostname: r.hostname,
      allowlist: Array.isArray(r.allowlist) ? (r.allowlist as string[]) : null,
      // A bridge from before keys were recorded cannot be cut off from here.
      can_disconnect: !!r.token_id,
    };
  });
  // The default bridge first, then by what people call them.
  return out.sort((a, b) =>
    a.bridge === null ? -1 : b.bridge === null ? 1 : (a.name ?? a.bridge).localeCompare(b.name ?? b.bridge),
  );
}

/** Give a bridge the name a person will recognise it by. False when this
 *  workspace has no such bridge. */
export async function renameBridge(orgId: string, bridge: string | null, name: string): Promise<boolean> {
  const r = await meta
    .updateTable("edge_bridges")
    .set({ name: name.trim().slice(0, 120) })
    .where("channel_key", "=", edgeChannelKey(orgId, bridge))
    .executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0) > 0;
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
async function claimNext(key: string, lanes: EdgeLane[] | null): Promise<EdgeRelayItem | null> {
  // A bridge that names its lanes is handed only work it can start now; one
  // that names none (an older bridge) is handed anything, as before.
  const laneFilter = lanes && lanes.length ? sql`AND (lane IS NULL OR lane IN (${sql.join(lanes)}))` : sql``;
  const rows = await sql<{ id: string; request: EdgeRequest; expires_at: Date }>`
    UPDATE edge_relay_jobs SET status = 'claimed', claimed_at = now()
     WHERE id = (
       SELECT id FROM edge_relay_jobs
        WHERE channel_key = ${key} AND status = 'queued' AND expires_at > now() ${laneFilter}
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id, request, expires_at
  `.execute(meta);
  const row = rows.rows[0];
  if (!row) return null;
  const req = row.request;
  // The bridge stops a little before Cobblr stops waiting, so its answer
  // (a 504 that says why) arrives instead of Cobblr's own timeout.
  const left = new Date(row.expires_at).getTime() - Date.now();
  const bridgeMs = Math.max(1_000, left - Math.min(5_000, Math.round(left * 0.1)));
  const method = EDGE_METHODS.includes(req.method as EdgeMethod) ? (req.method as EdgeMethod) : "GET";
  return {
    id: row.id,
    path: req.path,
    method,
    body: req.body,
    ...(req.instance ? { instance: req.instance } : {}),
    ...(req.source ? { source: req.source } : {}),
    timeoutMs: bridgeMs,
    lane: edgeLaneOf(req),
    ...(req.scope ? { scope: req.scope } : {}),
    ...(req.blob ? { blob: req.blob } : {}),
  };
}

export async function relayPoll(key: string, opts?: { signal?: AbortSignal; lanes?: EdgeLane[] | null }): Promise<EdgeRelayItem | null> {
  await relayTouch(key);
  const deadline = Date.now() + POLL_WAIT_MS;
  let checkedAt = Date.now();
  for (;;) {
    const item = await claimNext(key, opts?.lanes ?? null);
    if (item) return item;
    if (opts?.signal?.aborted || Date.now() >= deadline) return null;
    // A bridge disconnected while parked here ends its poll now, not at the 25 s deadline: its next
    // poll meets its revoked key. Disconnecting deletes the row this poll's touch made.
    if (Date.now() - checkedAt >= 1_000) {
      checkedAt = Date.now();
      const still = await meta.selectFrom("edge_bridges").select("channel_key").where("channel_key", "=", key).executeTakeFirst();
      if (!still) return null;
    }
    await sleep(CLAIM_POLL_MS);
    // Keep presence warm across a long park, or the reaper would call a bridge
    // that is sitting right here "disconnected". Update only, never create: a
    // poll that was already parked when the bridge was disconnected must not
    // put it back on the list.
    if (Date.now() % 10_000 < CLAIM_POLL_MS) {
      await meta.updateTable("edge_bridges").set({ last_seen: new Date() }).where("channel_key", "=", key).execute();
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function relayRespond(
  key: string,
  r: { id: string; status: number; body?: unknown; headers?: Record<string, string> },
): Promise<boolean> {
  // A bridge that retried late answers an id that is gone, and a confused one
  // answers something that was never an id at all. The column is uuid, so
  // handing that straight to Postgres throws — and in an async route with no
  // catch that leaves the request hanging rather than failing. Not-a-uuid is
  // simply "no such job".
  if (!UUID_RE.test(r.id)) return false;
  const res = await meta
    .updateTable("edge_relay_jobs")
    .set({ status: "done", done_at: new Date(), response: JSON.stringify({ status: r.status, body: r.body ?? null, ...(r.headers ? { headers: r.headers } : {}) }) })
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
  const key = edgeChannelKey(orgId, bridge);
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
