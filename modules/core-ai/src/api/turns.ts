// Chat turns: a turn is a persisted row plus a dense event log, not a request.
//
// The event log is the whole design. The loop appends as it goes (thinking,
// tool, tool-result, applied, text, done); a subscriber replays everything
// after the seq it last saw and then follows live. That one primitive gives:
//   * progress while the turn runs, instead of a dead widget for 30-150s;
//   * survival across a page refresh - the turn is server-side, the tab just
//     resubscribes and catches up;
//   * every tab of the same user in sync, including "in progress", because
//     they are all reading the same rows.
//
// Live delivery is an in-process listener map, PLUS the database as the source
// of truth. The map is an optimisation for the common case (the subscriber is
// on the same process as the loop); the replay-from-seq path is what makes it
// correct across processes and reconnects. A subscriber that misses a live
// push simply reads the row on its next poll tick, so nothing depends on the
// map being complete. This deliberately mirrors the edge relay backplane
// (platform/edge.ts): correctness in Postgres, speed in memory.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { CoreAiDB } from "../db.js";

export type TurnEventKind = "thinking" | "tool" | "tool-result" | "applied" | "text" | "done" | "error";
export interface TurnEvent {
  seq: number;
  kind: TurnEventKind;
  payload: Record<string, unknown>;
}

type Listener = (ev: TurnEvent) => void;
const listeners = new Map<string, Set<Listener>>();

export async function createTurn(db: Kysely<CoreAiDB>, userId: string, prompt: string): Promise<string> {
  const row = await db
    .insertInto("core_ai_chat_turns")
    .values({ user_id: userId, prompt, status: "running" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Append one event. seq is allocated in the same statement, so two writers
 *  on the same turn (they should not happen, but a retry could) never collide
 *  and a reader's "after N" is always dense. */
export async function emitTurnEvent(
  db: Kysely<CoreAiDB>,
  turnId: string,
  kind: TurnEventKind,
  payload: Record<string, unknown> = {},
): Promise<TurnEvent> {
  const rows = await sql<{ seq: number }>`
    insert into core_ai_chat_turn_events (turn_id, seq, kind, payload)
    values (
      ${turnId},
      coalesce((select max(seq) from core_ai_chat_turn_events where turn_id = ${turnId}), 0) + 1,
      ${kind},
      ${JSON.stringify(payload)}::jsonb
    )
    returning seq
  `.execute(db);
  const seq = rows.rows[0]!.seq;
  const ev: TurnEvent = { seq, kind, payload };
  await db
    .updateTable("core_ai_chat_turns")
    .set({ updated_at: new Date() } as never)
    .where("id", "=", turnId)
    .execute();
  for (const l of listeners.get(turnId) ?? []) {
    try {
      l(ev);
    } catch {
      /* a broken subscriber must not break the loop */
    }
  }
  return ev;
}

export async function finishTurn(
  db: Kysely<CoreAiDB>,
  turnId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string },
): Promise<void> {
  await db
    .updateTable("core_ai_chat_turns")
    .set(
      outcome.ok
        ? ({ status: "done", result: JSON.stringify(outcome.result), finished_at: new Date(), updated_at: new Date() } as never)
        : ({ status: "failed", error: outcome.error, finished_at: new Date(), updated_at: new Date() } as never),
    )
    .where("id", "=", turnId)
    .execute();
  await emitTurnEvent(db, turnId, outcome.ok ? "done" : "error", outcome.ok ? { result: outcome.result } : { message: outcome.error });
}

export async function readTurn(db: Kysely<CoreAiDB>, turnId: string) {
  return db.selectFrom("core_ai_chat_turns").selectAll().where("id", "=", turnId).executeTakeFirst();
}

export async function eventsAfter(db: Kysely<CoreAiDB>, turnId: string, afterSeq: number): Promise<TurnEvent[]> {
  const rows = await db
    .selectFrom("core_ai_chat_turn_events")
    .select(["seq", "kind", "payload"])
    .where("turn_id", "=", turnId)
    .where("seq", ">", afterSeq)
    .orderBy("seq")
    .execute();
  return rows.map((r) => ({
    seq: r.seq,
    kind: r.kind as TurnEventKind,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

/** The user's most recent turn that has not finished, if any. What a tab
 *  opening the chat asks first: "is something already running for me?" */
export async function openTurnFor(db: Kysely<CoreAiDB>, userId: string) {
  return db
    .selectFrom("core_ai_chat_turns")
    .select(["id", "prompt", "status", "created_at"])
    .where("user_id", "=", userId)
    .where("status", "in", ["queued", "running"])
    .orderBy("created_at", "desc")
    .executeTakeFirst();
}

export function subscribe(turnId: string, l: Listener): () => void {
  let set = listeners.get(turnId);
  if (!set) listeners.set(turnId, (set = new Set()));
  set.add(l);
  return () => {
    set!.delete(l);
    if (set!.size === 0) listeners.delete(turnId);
  };
}

/** Finished turns older than a day, and anything stranded "running" for over
 *  an hour (a process died mid-turn), get swept. Called from the module's
 *  existing sweeper tick. */
export async function sweepTurns(db: Kysely<CoreAiDB>): Promise<void> {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  await db
    .updateTable("core_ai_chat_turns")
    .set({ status: "failed", error: "the server restarted before this turn finished", finished_at: new Date() } as never)
    .where("status", "in", ["queued", "running"])
    .where("updated_at", "<", hourAgo)
    .execute();
  await db
    .deleteFrom("core_ai_chat_turns")
    .where("status", "in", ["done", "failed"])
    .where("finished_at", "<", dayAgo)
    .execute();
}
