// What one side of a share tells the other, and how it gets there.
//
// A share links a workspace to a share space, often on another Cobblr
// (docs/design-decisions/share-spaces.md). Each side writes what it has to say
// into an ordered outbox; a flush sends the oldest undelivered changes in one
// signed request and stops at the first failure, so the other side always
// applies them in the order they were made. The receiving side keeps the key of
// every change it applied (share_received), so a repeat delivery after a lost
// answer applies nothing twice. Nothing is lost while the other side is down:
// the changes wait and are retried with a growing pause, and the link says when
// it last synced and what went wrong.
//
// Both sides on one Cobblr is the same path with the network taken out: the
// flush hands the batch straight to the apply function the route would.

import { trustedPeers } from "./cloud.js";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { SERVICE_AUTH_SKEW_S, signServiceRequest, verifyServiceRequest, parseServiceKey } from "@cobblr/platform-contract/service-auth";
import { meta } from "../db/meta.js";
import { decryptCreds } from "../db/crypto.js";
import { runExclusive } from "./exclusive.js";

/** The envelope's format. A side that receives a newer one says so and
 *  applies none of it; the sender keeps the changes and tells its person the
 *  other Cobblr needs updating. */
export const SHARE_ENVELOPE_VERSION = 1;

export interface ShareOp {
  key: string;
  op: string;
  payload: Record<string, unknown>;
}

export type ShareLinkRow = {
  id: string;
  org_id: string;
  side: "owner" | "share";
  status: "pending" | "active" | "revoked";
  peer_url: string | null;
  peer_link_id: string | null;
  peer_name: string | null;
  send_key_encrypted: string | null;
  receive_key_id: string | null;
  receive_secret_encrypted: string | null;
};

type OpHandler = (link: ShareLinkRow, payload: Record<string, unknown>) => Promise<void>;
const HANDLERS = new Map<string, OpHandler>();

/** What a change means on the side that receives it. Registered once per op
 *  name; an op nobody registered is refused, never dropped. */
export function registerShareOp(op: string, handler: OpHandler): void {
  HANDLERS.set(op, handler);
}

export const newOpKey = () => randomBytes(12).toString("hex");

/** "This share has ended": the one change an ended link still delivers. */
export const REVOKED_OP = "link.revoked";

/** Put a change in the link's outbox and try to send it now. `key` makes a
 *  repeat enqueue of the same change a no-op. */
export async function enqueueShareOp(linkId: string, op: string, payload: Record<string, unknown>, key: string = newOpKey()): Promise<void> {
  await meta
    .insertInto("share_outbox")
    .values({ link_id: linkId, key, op, payload: JSON.stringify(payload) as never })
    .onConflict((oc) => oc.columns(["link_id", "key"]).doNothing())
    .execute();
  void flushShareLink(linkId).catch((err) => console.error(`[share] flush of ${linkId} failed:`, err));
}

const linkCols = [
  "id",
  "org_id",
  "side",
  "status",
  "peer_url",
  "peer_link_id",
  "peer_name",
  "send_key_encrypted",
  "receive_key_id",
  "receive_secret_encrypted",
] as const;

export async function getShareLink(id: string): Promise<ShareLinkRow | null> {
  return ((await meta.selectFrom("share_links").select([...linkCols]).where("id", "=", id).executeTakeFirst()) as ShareLinkRow | undefined) ?? null;
}

/** Seconds to wait after the n-th failed try: 30 s, then doubling, at most
 *  six hours. A peer down for a week is retried four times a day. */
export function retryAfterS(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 6 * 3600);
}

export class ShareDeliveryError extends Error {
  constructor(
    message: string,
    readonly needsUpdate = false,
    readonly gone = false,
  ) {
    super(message);
  }
}

/** The other Cobblr's address, fetched the way its kind of address must be:
 *  one the operator configured (COBBLR_SHARE_TRUSTED_PEERS) with plain fetch,
 *  like any operator-run service; one a person typed through the egress guard,
 *  which refuses a private address on a hosted instance. */
export async function peerFetch(orgId: string, url: string, init: RequestInit): Promise<Response> {
  const trusted = trustedPeers();
  const origin = new URL(url).origin;
  if (trusted.some((t) => t === origin)) return fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return platform().egress.guardedFetch(orgId, url, { ...init, signal: AbortSignal.timeout(30_000) });
}

/** POST to the other side of a paired link, signed with this side's key:
 *  the one way anything crosses to another Cobblr. */
export async function signedPeerPost(link: ShareLinkRow, path: string, body: unknown): Promise<Response> {
  if (!link.peer_url || !link.send_key_encrypted) throw new ShareDeliveryError("this share is not paired with another Cobblr");
  const key = parseServiceKey(decryptCreds(link.send_key_encrypted));
  if (!key) throw new ShareDeliveryError("this share's key is unreadable");
  const raw = JSON.stringify(body);
  const headers = signServiceRequest({ keyId: key.keyId, secret: key.secret, method: "POST", pathAndQuery: path, body: raw });
  try {
    return await peerFetch(link.org_id, `${link.peer_url}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: raw });
  } catch (err) {
    throw new ShareDeliveryError(`could not reach ${new URL(link.peer_url).host}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deliver(link: ShareLinkRow, ops: ShareOp[]): Promise<void> {
  if (!link.peer_link_id || !link.send_key_encrypted) throw new ShareDeliveryError("this share is not paired yet");
  const body = { v: SHARE_ENVELOPE_VERSION, ops };
  if (!link.peer_url) {
    const peer = await getShareLink(link.peer_link_id);
    if (!peer) throw new ShareDeliveryError("the other side of this share is gone", false, true);
    try {
      await applyShareOps(peer, body);
    } catch (err) {
      if (err instanceof ShareApplyError) throw new ShareDeliveryError(err.message, err.status === 426, err.status === 410);
      throw err;
    }
    return;
  }
  const res = await signedPeerPost(link, `/api/v1/share-links/${link.peer_link_id}/ops`, body);
  if (res.ok) return;
  const said = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (res.status === 426 || said?.error?.code === "needs_update") {
    throw new ShareDeliveryError(`${link.peer_name ?? "The other side"}'s Cobblr needs updating to sync this share`, true);
  }
  if (res.status === 410 || said?.error?.code === "share_revoked") throw new ShareDeliveryError("the other side ended this share", false, true);
  throw new ShareDeliveryError(said?.error?.message ?? `the other Cobblr answered ${res.status}`);
}

/** Send everything waiting for one link, oldest first, in batches, stopping at
 *  the first failure. Safe to call any time from any process: one flush per
 *  link at a time. */
export async function flushShareLink(linkId: string): Promise<{ sent: number; error: string | null; busy: boolean }> {
  let sent = 0;
  let error: string | null = null;
  const run = await runExclusive(`share.flush.${linkId}`, async () => {
    const link = await getShareLink(linkId);
    if (!link || link.status === "pending") return;
    const ended = link.status === "revoked";
    for (;;) {
      const due = await meta
        .selectFrom("share_outbox")
        .select(["id", "key", "op", "payload", "attempts", "next_at"])
        .where("link_id", "=", linkId)
        .where("sent_at", "is", null)
        .$if(ended, (q) => q.where("op", "=", REVOKED_OP))
        .orderBy("id")
        .limit(20)
        .execute();
      if (due.length === 0) break;
      // The oldest one decides: until it goes, nothing after it may.
      if (due[0]!.next_at > new Date()) break;
      const ops = due.map((r) => ({ key: r.key, op: r.op, payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown> }));
      try {
        await deliver(link, ops);
        await meta.updateTable("share_outbox").set({ sent_at: new Date(), last_error: null }).where("id", "in", due.map((r) => r.id)).execute();
        await meta.updateTable("share_links").set({ last_synced_at: new Date(), last_error: null, last_error_at: null }).where("id", "=", linkId).execute();
        sent += ops.length;
      } catch (err) {
        const e = err instanceof ShareDeliveryError ? err : new ShareDeliveryError(err instanceof Error ? err.message : String(err));
        error = e.message;
        const attempts = due[0]!.attempts + 1;
        const wait = e.needsUpdate ? 6 * 3600 : retryAfterS(attempts);
        await meta
          .updateTable("share_outbox")
          .set({ attempts, next_at: new Date(Date.now() + wait * 1000), last_error: e.message })
          .where("id", "=", due[0]!.id)
          .execute();
        await meta.updateTable("share_links").set({ last_error: e.message, last_error_at: new Date() }).where("id", "=", linkId).execute();
        if (e.gone) {
          // The other side already ended it: nothing more to send, and an
          // ended-notice has nothing left to say.
          await meta.updateTable("share_links").set({ status: "revoked", revoked_at: new Date() }).where("id", "=", linkId).execute();
          await meta.updateTable("share_outbox").set({ sent_at: new Date() }).where("link_id", "=", linkId).where("sent_at", "is", null).execute();
        }
        break;
      }
    }
  });
  return { sent, error, busy: !run.ran };
}

/** Flush now, waiting out a flush already running for the link (another
 *  process, or the one an enqueue just started) rather than skipping: a
 *  person pressing Sync now is told what actually happened. */
export async function flushShareLinkNow(linkId: string, waitMs = 15_000): Promise<{ sent: number; error: string | null }> {
  const until = Date.now() + waitMs;
  let sent = 0;
  for (;;) {
    // A person asking is a reason to try now, whatever pause a failure set,
    // including one a flush that was running set a moment ago.
    await meta.updateTable("share_outbox").set({ next_at: new Date() }).where("link_id", "=", linkId).where("sent_at", "is", null).execute();
    const r = await flushShareLink(linkId);
    sent += r.sent;
    if (!r.busy || Date.now() > until) return { sent, error: r.error };
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** Every link with something due, flushed: the retry loop's whole job. */
export async function flushDueShareLinks(): Promise<void> {
  const due = await meta
    .selectFrom("share_outbox as o")
    .innerJoin("share_links as l", "l.id", "o.link_id")
    .select("o.link_id")
    .distinct()
    .where("o.sent_at", "is", null)
    .where("o.next_at", "<=", new Date())
    .where((eb) => eb.or([eb("l.status", "=", "active"), eb.and([eb("l.status", "=", "revoked"), eb("o.op", "=", REVOKED_OP)])]))
    .limit(200)
    .execute();
  for (const { link_id } of due) await flushShareLink(link_id).catch((err) => console.error(`[share] flush of ${link_id} failed:`, err));
  // Delivered changes are kept a week for the record, nonces as long as a
  // signature could be replayed.
  await meta.deleteFrom("share_outbox").where("sent_at", "<", new Date(Date.now() - 7 * 86_400_000)).execute();
  await meta.deleteFrom("share_nonces").where("seen_at", "<", new Date(Date.now() - 2 * SERVICE_AUTH_SKEW_S * 1000)).execute();
}

let handle: ReturnType<typeof setInterval> | null = null;
const loopPasses: Array<() => Promise<void>> = [];
/** More work for the sync loop's tick (a share's mirror), after the flush. */
export function addShareSyncPass(fn: () => Promise<void>): void {
  loopPasses.push(fn);
}
const runLoop = () =>
  // SKIP-IF-BUSY OK: hands the outcome back; each caller reads .ran or says why it may skip
  runExclusive("share.sync-loop", async () => {
    await flushDueShareLinks();
    for (const fn of loopPasses) await fn().catch((err) => console.error("[share] sync pass:", err));
  });
const tick = () =>
  // SKIP-IF-BUSY OK: a timer tick; the holder flushes every due link, the next tick retries the rest
  void runLoop().catch((err) => console.error("[share] sync loop:", err));

export function startShareSync(): void {
  if (handle) clearInterval(handle);
  // Each link flushes under runExclusive, so two api processes on one database
  // never send a link's changes twice or out of order.
  handle = setInterval(tick, 30_000);
}

let kicked: ReturnType<typeof setTimeout> | null = null;
let kickedAt = 0;
const wanted: number[] = [];
/** Something shared just changed: run the loop at about this time rather
 *  than on its next tick. Several asks run once each, in order, and an ask
 *  inside a second of one already waiting rides with it, so a burst of
 *  changes is one run. Each pass still checks its own settle time; a run that
 *  comes too early finds nothing due and the next tick catches it. */
export function kickShareSync(afterMs = 6_000): void {
  if (!handle) return;
  const at = Date.now() + afterMs;
  if (!wanted.some((w) => Math.abs(w - at) < 1_000)) wanted.push(at);
  wanted.sort((x, y) => x - y);
  const next = wanted[0]!;
  if (kicked && kickedAt <= next) return;
  if (kicked) clearTimeout(kicked);
  kickedAt = next;
  kicked = setTimeout(() => {
    kicked = null;
    while (wanted.length && wanted[0]! <= Date.now() + 250) wanted.shift();
    void runLoop()
      .then((run) => {
        // A loop already running may have read what is due before this
        // change was: ask again in a moment rather than wait for the tick.
        if (!run.ran) kickShareSync(1_500);
      })
      .catch((err) => console.error("[share] sync loop:", err));
    if (wanted.length) kickShareSync(Math.max(0, wanted.shift()! - Date.now()));
  }, Math.max(0, next - Date.now()));
  kicked.unref?.();
}

export class ShareApplyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Apply a batch the other side sent, in order, skipping what was already
 *  applied. A newer envelope than this Cobblr reads applies nothing. */
export async function applyShareOps(link: ShareLinkRow, body: unknown): Promise<{ applied: string[] }> {
  const b = (body ?? {}) as { v?: unknown; ops?: unknown };
  const v = typeof b.v === "number" ? b.v : 0;
  if (v > SHARE_ENVELOPE_VERSION) throw new ShareApplyError(426, "needs_update", `This Cobblr reads share changes up to version ${SHARE_ENVELOPE_VERSION}; this one is ${v}. It needs updating.`);
  if (link.status === "revoked") throw new ShareApplyError(410, "share_revoked", "This share has ended.");
  const ops = Array.isArray(b.ops) ? (b.ops as ShareOp[]) : [];
  const applied: string[] = [];
  for (const o of ops) {
    if (!o || typeof o.key !== "string" || typeof o.op !== "string") throw new ShareApplyError(400, "bad_op", "A change without a key or a name.");
    const seen = await meta.selectFrom("share_received").select("key").where("link_id", "=", link.id).where("key", "=", o.key).executeTakeFirst();
    if (seen) {
      applied.push(o.key);
      continue;
    }
    const handler = HANDLERS.get(o.op);
    if (!handler) throw new ShareApplyError(426, "needs_update", `This Cobblr does not know the change "${o.op}"; it needs updating.`);
    await handler(link, (o.payload ?? {}) as Record<string, unknown>);
    // A change can end the link itself (a share space taken away with its
    // link): then there is nothing left to remember it against.
    await meta
      .insertInto("share_received")
      .columns(["link_id", "key"])
      .expression((eb) => eb.selectFrom("share_links").select([eb.val(link.id).as("link_id"), eb.val(o.key).as("key")]).where("id", "=", link.id))
      .onConflict((oc) => oc.doNothing())
      .execute();
    applied.push(o.key);
  }
  await meta.updateTable("share_links").set({ last_synced_at: new Date() }).where("id", "=", link.id).execute();
  return { applied };
}

/** Check a request the other side signed: the key belongs to this link, the
 *  signature holds over the exact bytes, and the nonce is new. */
export async function verifyShareRequest(p: {
  linkId: string;
  headers: Record<string, string | undefined>;
  pathAndQuery: string;
  rawBody: string | undefined;
}): Promise<ShareLinkRow> {
  // Every signed per-link door keeps its exact bytes (server.ts); a door that
  // does not would read every signature as forged, so say what is wrong.
  if (p.rawBody === undefined) throw new ShareApplyError(500, "raw_body_missing", "This door does not keep the request's exact bytes, so no signature can be checked.");
  const link = await getShareLink(p.linkId);
  if (!link || !link.receive_key_id || !link.receive_secret_encrypted) throw new ShareApplyError(404, "unknown_share", "No such share.");
  const secret = decryptCreds(link.receive_secret_encrypted);
  const r = verifyServiceRequest({
    headers: p.headers,
    secretFor: (keyId) => (keyId === link.receive_key_id ? secret : null),
    method: "POST",
    pathAndQuery: p.pathAndQuery,
    body: p.rawBody,
  });
  if (!r.ok) throw new ShareApplyError(401, "bad_signature", `The request is not signed by this share's other side (${r.reason}).`);
  const fresh = await meta
    .insertInto("share_nonces")
    .values({ key_id: r.keyId, nonce: p.headers["x-cobblr-nonce"] ?? "" })
    .onConflict((oc) => oc.doNothing())
    .returning(sql<number>`1`.as("one"))
    .executeTakeFirst();
  if (!fresh) throw new ShareApplyError(401, "replayed", "That request was already received.");
  return link;
}
