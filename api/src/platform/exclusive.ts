// One owner per named job, across every api process sharing this database.
//
// THE PROBLEM THIS EXISTS FOR. A periodic loop is started by every api process
// (a module's lifecycle.onBoot, a kernel sweeper). For most of this platform's
// life that meant one process, so "started at boot" and "runs once" were the
// same sentence. They are not the same sentence any more: the canary channel
// runs a SECOND api against the very same Postgres (design-decisions/
// canary-channel.md), and a rolling deploy briefly runs two as well. Every
// side-effecting loop then does its work twice on real user data.
//
// It was found in the mildest possible way, which is the only luck in it: a
// workspace's printer posted its progress to Discord twice, every time, for
// weeks (2026-08-29). The same doubling was running through every unguarded
// sweeper in the tree.
//
// The mechanic is the one delivery-sweeper.ts already proved (audit B4c) and
// is lifted here so nobody has to re-derive it: a session-scoped
// pg_try_advisory_lock, acquired and released on ONE pinned connection.
//
// WHAT THIS DOES AND DOES NOT PROMISE. It guarantees the work does not run
// CONCURRENTLY in two processes. It does not by itself guarantee the work
// happens once: the loser skips this tick, but its next tick may find the job
// free and do it again. So the work must be idempotent, or must claim what it
// is about to act on (delete the bucket, compare-and-set the row) INSIDE the
// lock. Where a claim is available, the claim is the real guard and this is
// contention control on top of it.

import type { ExclusiveRun } from "@cobblr/platform-contract";
import type { Client } from "pg";
import { lockKeyFor } from "./advisory-lock.js";
import { IDLE_RELEASE_MS } from "../db/connection-budget.js";

export { lockKeyFor, withAdvisoryLock } from "./advisory-lock.js";

/**
 * Run `work` only if no other api process is running the job of this name.
 *
 * Says whether this process ran it ({ ran: true }) or someone else held it. A
 * skipped tick is the normal, correct outcome for a timer, never an error;
 * a caller that reports what it did to a person must not read a skip as
 * "nothing to do" (lint:exclusive-answer-read).
 *
 * The lock lives on the api's one lock connection (holdShared below), never
 * a client borrowed from the meta pool. A session lock has to
 * stay on one connection for as long as the work runs, and the work of a
 * sweep is minutes of fetches and tenant rounds; borrowed from the pool, that
 * was one request's worth of capacity spent for the whole sweep, and a sweep
 * that hung spent it forever. Six such jobs and a pool of ten is how the api
 * hung on the dev rig with nothing in the log (#3033). The work itself uses
 * the pool through `meta` like any request, and gives each client back per
 * statement.
 */
export async function runExclusive(name: string, work: () => Promise<void>): Promise<ExclusiveRun> {
  const held = await tryHoldExclusive(name);
  if (!held) return { ran: false, heldElsewhere: true };
  try {
    await work();
  } finally {
    await held.release();
  }
  return { ran: true };
}

/** The lock as a HANDLE: taken now, released by the caller. For a holder that
 *  runs several jobs' work interleaved (the tenant sweeps walk the workspaces
 *  once for every pass that is due, and must hold every one of those passes'
 *  locks for the length of the walk). Null when another process, or another
 *  caller in this one, holds it. */
export async function tryHoldExclusive(name: string): Promise<{ release: () => Promise<void> } | null> {
  return holdShared(name);
}

/** Many locks taken by one holder and let go together: the tenant-sweep walk
 *  takes a lock per due pass and one per workspace it visits, and close()
 *  lets go of whatever it still holds. */
export interface LockSession {
  tryHold: (name: string) => Promise<{ release: () => Promise<void> } | null>;
  close: () => Promise<void>;
}

export async function openLockSession(): Promise<LockSession> {
  const mine = new Set<{ release: () => Promise<void> }>();
  return {
    tryHold: async (name) => {
      const held = await holdShared(name);
      if (!held) return null;
      const handle = {
        release: async () => {
          mine.delete(handle);
          await held.release();
        },
      };
      mine.add(handle);
      return handle;
    },
    close: async () => {
      await Promise.all([...mine].map((h) => h.release().catch(() => {})));
    },
  };
}

// Every try-lock this api takes is on ONE connection. A connection per lock,
// or per walk, was nobody's plan: each sweeps.run and sweeps.soon opened its
// own and waited on it up to a minute, every runExclusive dialled one, and
// on a catch-up roll the new api held 87 to 101 of them still logging in,
// beside a plan of 46 (staging, 2026-11-01, 7,246 refusals). A session's
// advisory locks are re-entrant within it, so who holds what in THIS process
// is kept here; Postgres keeps the other processes out.
type LockLink = { client: Pick<Client, "query" | "end">; alive: boolean; lose: () => void };
let link: Promise<LockLink> | null = null;
let linkIdle: ReturnType<typeof setTimeout> | null = null;
const heldHere = new Set<string>();
/** After the server refuses the lock connection, no lock dials again until
 *  this wait is out, doubling while it keeps refusing: a refusal answered by
 *  another login at once is how a full server stays full. */
export const LOCK_REFUSED_WAIT_MS = { first: 1_000, cap: 30_000 };
const LOCK_CONNECT_TIMEOUT_MS = 10_000;
/** The longest a lock statement may take, counted from when it is asked, so
 *  one queued behind it is bounded too. Every try-lock in the api shares the
 *  connection, so a statement stuck on it would stall every sweep and job:
 *  past this it is abandoned and the connection replaced. A try-lock never
 *  waits on another holder; a slow one is a busy server or a dead socket. */
export const LOCK_QUERY_TIMEOUT_MS = 5_000;

export class LockQueryTimeout extends Error {
  constructor() {
    super(`a lock statement took longer than ${LOCK_QUERY_TIMEOUT_MS / 1000}s; the lock connection is replaced`);
    this.name = "LockQueryTimeout";
  }
}
let refusedWait = 0;
let refusedUntil = 0;

export class LockConnectionResting extends Error {
  constructor(ms: number) {
    super(`the lock connection was refused; no lock is tried for another ${Math.ceil(ms / 1000)}s`);
    this.name = "LockConnectionResting";
  }
}

async function lockLink(): Promise<LockLink> {
  if (link) return link;
  const rest = refusedUntil - Date.now();
  if (rest > 0) throw new LockConnectionResting(rest);
  const { env } = await import("../env.js");
  const { createClient } = await import("../db/client-error-guard.js");
  if (link) return link;
  const opening: Promise<LockLink> = (async () => {
    const client: Client = createClient({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: LOCK_CONNECT_TIMEOUT_MS, statement_timeout: LOCK_QUERY_TIMEOUT_MS }, "advisory-lock");
    // A lost connection lost its locks with it: the next lock opens another,
    // and a release on the dead one has nothing to let go of.
    const lost = () => {
      l.alive = false;
      if (link === opening) link = null;
    };
    const l: LockLink = { client, alive: true, lose: lost };
    if (typeof (client as { once?: unknown }).once === "function") {
      client.once("error", lost);
      client.once("end", lost);
    }
    await client.connect();
    return l;
  })();
  link = opening;
  try {
    const l = await opening;
    refusedWait = 0;
    return l;
  } catch (err) {
    if (link === opening) link = null;
    refusedWait = Math.min(LOCK_REFUSED_WAIT_MS.cap, refusedWait ? refusedWait * 2 : LOCK_REFUSED_WAIT_MS.first);
    refusedUntil = Date.now() + refusedWait;
    throw err;
  }
}

/** One statement on the shared connection, within LOCK_QUERY_TIMEOUT_MS of
 *  being asked. Past it the connection is ended, not waited on: its locks go
 *  with it, which is what a dead socket would have done anyway, and every
 *  other caller moves to a fresh one instead of queueing behind the stuck one. */
async function ask<R>(l: LockLink, text: string, key: string): Promise<{ rows: R[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      l.lose();
      void Promise.resolve(l.client.end()).catch(() => {});
      reject(new LockQueryTimeout());
    }, LOCK_QUERY_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return (await Promise.race([l.client.query(text, [key]), late])) as { rows: R[] };
  } finally {
    clearTimeout(timer);
  }
}

async function holdShared(name: string): Promise<{ release: () => Promise<void> } | null> {
  // Claimed before the first await, so two callers here cannot both pass.
  if (heldHere.has(name)) return null;
  heldHere.add(name);
  if (linkIdle) {
    clearTimeout(linkIdle);
    linkIdle = null;
  }
  const key = lockKeyFor(name).toString();
  let l: LockLink;
  let locked = false;
  try {
    l = await lockLink();
    const got = await ask<{ locked: boolean }>(l, "select pg_try_advisory_lock($1) as locked", key);
    locked = got.rows[0]?.locked ?? false;
  } catch (err) {
    forget(name);
    throw err;
  }
  if (!locked) {
    forget(name);
    return null;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        if (l.alive) await ask(l, "select pg_advisory_unlock($1)", key);
      } finally {
        forget(name);
      }
    },
  };
}

/** Lets go of a name here, and of the connection once nothing is held on it
 *  for a while: a quiet api keeps no lock connection open. */
function forget(name: string): void {
  heldHere.delete(name);
  if (heldHere.size || linkIdle || !link) return;
  linkIdle = setTimeout(() => {
    linkIdle = null;
    if (heldHere.size || !link) return;
    const closing = link;
    link = null;
    void closing.then((l) => l.client.end()).catch(() => {});
  }, IDLE_RELEASE_MS);
  (linkIdle as { unref?: () => void }).unref?.();
}

/** Tests: forget the shared connection, its wait and what it holds. */
export function resetLockLinkForTests(): void {
  if (linkIdle) clearTimeout(linkIdle);
  linkIdle = null;
  link = null;
  heldHere.clear();
  refusedWait = 0;
  refusedUntil = 0;
}

/**
 * Run `work` once every other holder of `name` has finished, across every api
 * process: the WAITING form, for a request that must still do its work after
 * losing the race (a sweep can skip a tick; a person's install cannot).
 *
 * Two doors filing rows for the same absent app at once (two devices, a tap
 * during File all) used to run the install twice concurrently. Serialised,
 * the second one finds the table the first made. Gives up after `waitMs`
 * rather than holding a request forever behind a stuck holder.
 */
export async function runSerialised<T>(name: string, work: () => Promise<T>, waitMs = 60_000): Promise<T> {
  const key = lockKeyFor(name).toString();
  const timeout = Math.max(1, Math.floor(waitMs));
  const held = await lockConnection(name, Date.now() + timeout);
  let clean = true;
  try {
    // A pooled connection keeps the session's setting: set it only when it differs.
    if (held.timeout !== timeout) {
      await held.client.query(`set lock_timeout = ${timeout}`);
      held.timeout = timeout;
    }
    await held.client.query("select pg_advisory_lock($1)", [key]);
    try {
      return await work();
    } finally {
      // A connection whose unlock did not land may still hold the lock: it is
      // closed, never handed to the next caller.
      await held.client.query("select pg_advisory_unlock($1)", [key]).catch(() => { clean = false; });
    }
  } catch (err) {
    clean = false;
    throw err;
  } finally {
    held.done(clean);
  }
}

/** A connection a serialised run holds its lock on. Opening one per run (a
 *  connect, a password exchange, a disconnect) was the largest part of
 *  deleting one record, about 27 ms of a 90 ms delete (#5286), and every
 *  record's delete takes one. They come from a small pool of warm ones; when
 *  none is free soon (many locks at once, a lock taken inside another's work),
 *  a fresh connection is opened, up to LOCK_FALLBACKS of them at once, so a
 *  lock taken inside another's work never waits on itself. Past that a caller
 *  waits for one to come back, until `deadline`: thirty callers waiting on one
 *  lock opened thirty-one connections, none of them in the plan the api sizes
 *  itself by, and on a catch-up boot the server ran out (staging, 10-31). */
type Held = { client: Pick<Client, "query">; timeout: number | undefined; done: (clean: boolean) => void };
let lockPool: import("pg").Pool | null = null;
let fallbacksOpen = 0;
async function lockConnection(name: string, deadline: number): Promise<Held> {
  const { env } = await import("../env.js");
  const { createClient, createPool } = await import("../db/client-error-guard.js");
  lockPool ??= createPool({ connectionString: env.DATABASE_URL, max: LOCK_POOL_SIZE, min: 0, idleTimeoutMillis: IDLE_RELEASE_MS, connectionTimeoutMillis: 2_000 }, "advisory-locks");
  for (;;) {
    try {
      const pooled = (await lockPool.connect()) as import("pg").PoolClient & { lockTimeout?: number };
      return {
        client: pooled,
        get timeout() { return pooled.lockTimeout; },
        set timeout(v) { pooled.lockTimeout = v; },
        done: (clean) => pooled.release(clean ? undefined : true),
      };
    } catch (err) {
      if (fallbacksOpen < LOCK_FALLBACKS) break;
      if (Date.now() >= deadline) throw new Error(`no connection free for the lock ${name}: ${(err as Error).message}`);
    }
  }
  fallbacksOpen++;
  const client: Client = createClient({ connectionString: env.DATABASE_URL }, `advisory-lock ${name}`);
  let given = false;
  const giveBack = () => {
    if (given) return;
    given = true;
    fallbacksOpen--;
    void client.end().catch(() => {});
  };
  try {
    await client.connect();
  } catch (err) {
    giveBack();
    throw err;
  }
  return { client, timeout: undefined, done: giveBack };
}
/** Warm connections kept for serialised runs. */
const LOCK_POOL_SIZE = 8;
/** Fresh connections a serialised run may open when the warm ones are all busy. */
const LOCK_FALLBACKS = 4;
/** What this api can hold on cobblr_meta for locks, outside the meta pool:
 *  the warm pool, its fresh overflow and the one connection every try-lock
 *  shares. The connection budget counts it. */
export const LOCK_CONNECTIONS = LOCK_POOL_SIZE + LOCK_FALLBACKS + 1;
