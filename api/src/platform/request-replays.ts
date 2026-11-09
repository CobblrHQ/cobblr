// A retry never doubles (#7923).
//
// A part's create reached the server and was saved, its answer was lost on
// the way back, the form said "Couldn't create part", and pressing Create
// again made a second part (#7835). Any write can be sent twice that way: a
// lost answer, a double tap, a reconnect replaying what it queued. So a write
// may carry an Idempotency-Key, and the first answer to that key is kept for
// a day, per person: a repeat with the same key and the same request is
// answered with it and runs nothing; one still running is waited for; the
// same key on a different request is refused. A write that failed on the
// server (5xx) keeps nothing, so asking again runs it again.
//
// The clients send one key per write and keep it only while its outcome is
// unknown (platform-web write-identity.ts), so a deliberate second create is
// still a second create. The kernel door every workspace route passes
// (withTenant) asks here, so a route added tomorrow is covered the day it
// lands. A person's write that no workspace holds yet (making a workspace)
// asks through replayAccountWrite, kept per person instead.

import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";

export const REPLAY_KEPT_MS = 24 * 60 * 60 * 1000;
const WAIT_FOR_RUNNING_MS = 15_000;
// A first request that never finished (the process went away mid-write)
// holds its key no longer than this.
const RUNNING_GIVES_UP_MS = 5 * 60_000;
// An answer bigger than this is not kept: a repeat is told it was done.
const KEPT_BODY_MAX = 256 * 1024;
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function fingerprintOf(req: Request): string {
  const body = req.is("multipart/form-data") ? null : (req.body ?? null);
  return createHash("sha256").update(`${req.method} ${req.originalUrl}\n${JSON.stringify(body)}`).digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Kept = { fingerprint: string; state: "running" | "done" | "unreplayable"; status: number | null; content_type: string | null; body: string | null; created_at: Date };
type Settled = { state: "done" | "unreplayable"; status: number; content_type?: string | null; body?: string };

/** Where one scope keeps its answers: a workspace's writes per person, or a
 *  person's own writes that belong to no workspace yet (making one). */
interface ReplayStore {
  claim(key: string, fingerprint: string): Promise<boolean>;
  find(key: string): Promise<Kept | undefined>;
  dropRunning(key: string): Promise<void>;
  forget(key: string): Promise<unknown>;
  settle(key: string, kept: Settled): Promise<unknown>;
}

function workspaceStore(orgId: string, userId: string): ReplayStore {
  return {
    claim: async (key, fingerprint) => !!(await meta.insertInto("request_replays").values({ org_id: orgId, user_id: userId, key, fingerprint }).onConflict((oc) => oc.doNothing()).returning("key").executeTakeFirst()),
    find: (key) => meta.selectFrom("request_replays").selectAll().where("org_id", "=", orgId).where("user_id", "=", userId).where("key", "=", key).executeTakeFirst(),
    dropRunning: async (key) => { await meta.deleteFrom("request_replays").where("org_id", "=", orgId).where("user_id", "=", userId).where("key", "=", key).where("state", "=", "running").execute(); },
    forget: (key) => meta.deleteFrom("request_replays").where("org_id", "=", orgId).where("user_id", "=", userId).where("key", "=", key).execute(),
    settle: (key, kept) => meta.updateTable("request_replays").set(kept).where("org_id", "=", orgId).where("user_id", "=", userId).where("key", "=", key).execute(),
  };
}

function accountStore(userId: string): ReplayStore {
  return {
    claim: async (key, fingerprint) => {
      // This person's answers older than a day go as they send the next one:
      // no walk of every account is needed to keep the table small.
      await meta.deleteFrom("account_request_replays").where("user_id", "=", userId).where("created_at", "<", new Date(Date.now() - REPLAY_KEPT_MS)).execute();
      return !!(await meta.insertInto("account_request_replays").values({ user_id: userId, key, fingerprint }).onConflict((oc) => oc.doNothing()).returning("key").executeTakeFirst());
    },
    find: (key) => meta.selectFrom("account_request_replays").selectAll().where("user_id", "=", userId).where("key", "=", key).executeTakeFirst(),
    dropRunning: async (key) => { await meta.deleteFrom("account_request_replays").where("user_id", "=", userId).where("key", "=", key).where("state", "=", "running").execute(); },
    forget: (key) => meta.deleteFrom("account_request_replays").where("user_id", "=", userId).where("key", "=", key).execute(),
    settle: (key, kept) => meta.updateTable("account_request_replays").set(kept).where("user_id", "=", userId).where("key", "=", key).execute(),
  };
}

/** Answer a repeated workspace write from what its first answer was, or
 *  record this one's answer. True when the request has been answered here. */
export function replayOrRecord(req: Request, res: Response, next: NextFunction, orgId: string, userId: string): Promise<boolean> {
  return replayFrom(workspaceStore(orgId, userId), req, res, next);
}

/** The same door for a person's write that no workspace holds: making a
 *  workspace. Its answer was lost, Create was pressed again, and a second
 *  workspace was made (#7923). Mounted after requireAuth. */
export async function replayAccountWrite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.session) return next();
    if (!(await replayFrom(accountStore(req.session.id), req, res, next))) next();
  } catch (err) {
    next(err);
  }
}

async function replayFrom(store: ReplayStore, req: Request, res: Response, next: NextFunction): Promise<boolean> {
  const key = req.get("idempotency-key");
  if (!key || !MUTATING.has(req.method)) return false;
  if (!KEY.test(key)) {
    res.status(400).json({ error: { code: "idempotency_key_invalid", message: "Idempotency-Key must be 8 to 128 letters, digits or . _ : -" } });
    return true;
  }
  const fingerprint = fingerprintOf(req);
  for (const deadline = Date.now() + WAIT_FOR_RUNNING_MS; ; ) {
    if (await store.claim(key, fingerprint)) {
      record(res, store, key);
      next();
      return true;
    }
    const row = await store.find(key);
    if (!row) continue;
    if (row.fingerprint !== fingerprint) {
      res.status(422).json({ error: { code: "idempotency_key_reused", message: "This Idempotency-Key was already used for a different request." } });
      return true;
    }
    if (row.state === "done") {
      res.status(row.status ?? 200).set("Idempotent-Replayed", "true");
      if (row.content_type) res.type(row.content_type);
      res.send(row.body ?? "");
      return true;
    }
    if (row.state === "unreplayable") {
      res.status(409).set("Idempotent-Replayed", "true").json({ error: { code: "request_already_done", message: "This was already done; its answer was too large to keep. Reload to see it." } });
      return true;
    }
    if (Date.now() - new Date(row.created_at).getTime() > RUNNING_GIVES_UP_MS) {
      await store.dropRunning(key);
      continue;
    }
    if (Date.now() > deadline) {
      res.status(409).set("Retry-After", "2").json({ error: { code: "request_in_progress", message: "This is still being done. Try again in a moment." } });
      return true;
    }
    await sleep(200);
  }
}

/** Keep this response's status and body under its key once it is sent. */
function record(res: Response, store: ReplayStore, key: string): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let streamed = false;
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  const keep = (chunk: unknown, encoding?: unknown) => {
    if (chunk == null || typeof chunk === "function") return;
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    size += b.length;
    if (size <= KEPT_BODY_MAX) chunks.push(b);
  };
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    streamed = true;
    keep(chunk, rest[0]);
    return write(chunk, ...rest);
  }) as typeof res.write;
  // Kept when the handler ends its answer, not when the answer reaches the
  // client: a connection lost on the way back is the case this exists for.
  let settled = false;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    keep(chunk, rest[0]);
    if (!settled) {
      settled = true;
      settle();
    }
    return end(chunk, ...rest);
  }) as typeof res.end;
  function settle() {
    const done =
      res.statusCode >= 500
        ? store.forget(key)
        : streamed || size > KEPT_BODY_MAX
          ? store.settle(key, { state: "unreplayable", status: res.statusCode })
          : store.settle(key, { state: "done", status: res.statusCode, content_type: String(res.getHeader("content-type") ?? "") || null, body: Buffer.concat(chunks).toString("utf8") });
    done.catch((err: Error) => console.warn(`[request-replays] could not keep the answer to ${key}: ${err.message}`));
  }
}

export function registerRequestReplaysSweep(): void {
  platform().sweeps.register({
    name: "platform.request-replays",
    everyMs: 6 * 60 * 60 * 1000,
    drainMs: 60_000,
    visit: async ({ orgId, now }) => {
      await meta.deleteFrom("request_replays").where("org_id", "=", orgId).where("created_at", "<", new Date(now.getTime() - REPLAY_KEPT_MS)).execute();
    },
  });
}
