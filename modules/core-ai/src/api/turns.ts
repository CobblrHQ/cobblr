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
import { serializeByKey, releaseKey } from "./serialize-by-key.js";
import type { CoreAiDB } from "../db.js";

/** "text-delta" is the answer arriving as it is written, one piece per event.
 *  Dense like the rest, so a tab that joins late replays what it missed and
 *  ends up with the same words. */
export type TurnEventKind = "thinking" | "tool" | "tool-result" | "applied" | "text" | "text-delta" | "done" | "error";
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

/** Append one event.
 *
 *  Serialised per TURN. seq is allocated inside the insert, so concurrent
 *  writers never collide on a number — but they can still land out of ORDER,
 *  and the loop emits fire-and-forget so two were regularly in flight at once.
 *  The event that suffered was the last one: `done` could be inserted before an
 *  earlier `tool-result`, and a reader that stops at `done` (every reader) then
 *  saw a turn that used no tools. That is the intermittent replay-test failure,
 *  and the same reason a long answer sometimes showed no steps.
 *
 *  Queueing here rather than at each call site means every emitter gets it:
 *  the loop's sink, an applied write, and finishTurn's terminal event. */
export async function emitTurnEvent(
  db: Kysely<CoreAiDB>,
  turnId: string,
  kind: TurnEventKind,
  payload: Record<string, unknown> = {},
): Promise<TurnEvent> {
  const ev = await serializeByKey(turnId, () => insertTurnEvent(db, turnId, kind, payload));
  // A turn is over after these; nothing may queue behind them.
  if (kind === "done" || kind === "error") releaseKey(turnId);
  return ev;
}

async function insertTurnEvent(
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

/** How long a "running" turn may go untouched before it is certainly dead.
 *
 *  A turn runs INSIDE one api process. If that process goes away — a deploy, a
 *  crash, a container replaced under a rolling update — the row keeps saying
 *  "running" and nobody is ever going to finish it. The widget believes the
 *  row, so it shows "Thinking…" for as long as the user leaves the tab open,
 *  and reattaches to the same dead turn on every reload. A user watched one sit
 *  there for an hour (2026-08-19).
 *
 *  The number is provable rather than a guess: emitTurnEvent bumps updated_at,
 *  and a live turn cannot exceed the 5-minute deadline in chat.ts because that
 *  deadline fails it. So anything untouched for longer than the deadline plus a
 *  grace has no one working on it. Kept in step with TURN_DEADLINE_MS by the
 *  test that pins both. */
export const STRANDED_AFTER_MS = 6 * 60_000;

export function isStranded(t: { status: string; updated_at: Date | string }): boolean {
  if (t.status !== "running" && t.status !== "queued") return false;
  const touched = t.updated_at instanceof Date ? t.updated_at.getTime() : Date.parse(String(t.updated_at));
  return Number.isFinite(touched) && Date.now() - touched > STRANDED_AFTER_MS;
}

/** Mark a turn nobody is working on as failed, and say so honestly.
 *
 *  Healing on READ rather than only in the sweeper is the point: the sweeper
 *  fires on roughly one turn in fifty IN THE SAME WORKSPACE, so a user whose
 *  turn was stranded would have had to send fifty more messages to clear the
 *  spinner they were stuck behind. The person looking at it is exactly the
 *  person who should not have to wait. */
async function healStranded(db: Kysely<CoreAiDB>, turnId: string): Promise<void> {
  await db
    .updateTable("core_ai_chat_turns")
    .set({
      status: "failed",
      error: "the server restarted before this finished, so it was never completed. Nothing was changed - ask again.",
      finished_at: new Date(),
      updated_at: new Date(),
    } as never)
    .where("id", "=", turnId)
    .where("status", "in", ["queued", "running"])
    .execute();
  // The event log is what a subscribed tab is reading, so it needs the ending
  // too — otherwise an open stream keeps waiting on a turn the row has closed.
  await emitTurnEvent(db, turnId, "error", {
    message: "the server restarted before this finished, so it was never completed. Nothing was changed - ask again.",
  }).catch(() => {
    /* the row is what matters; a missing event just means the poll finds it */
  });
}

export async function readTurn(db: Kysely<CoreAiDB>, turnId: string) {
  const turn = await db
    .selectFrom("core_ai_chat_turns")
    .selectAll()
    .where("id", "=", turnId)
    .executeTakeFirst();
  if (!turn || !isStranded(turn)) return turn;
  await healStranded(db, turnId);
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
  const turn = await db
    .selectFrom("core_ai_chat_turns")
    .select(["id", "prompt", "status", "created_at", "updated_at"])
    .where("user_id", "=", userId)
    .where("status", "in", ["queued", "running"])
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  // This is what a freshly opened tab asks. Handing it a stranded turn is how
  // a dead spinner outlives the process that created it, and how a reload
  // reattaches to the same corpse rather than clearing it.
  if (turn && isStranded(turn)) {
    await healStranded(db, turn.id);
    return undefined;
  }
  return turn;
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
  // The same rule the read side heals by, so a turn cannot be "dead when you
  // look at it, alive to the sweeper". It used to be an hour, which outlived
  // any reason to wait.
  const strandedBefore = new Date(Date.now() - STRANDED_AFTER_MS);
  await db
    .updateTable("core_ai_chat_turns")
    .set({
      status: "failed",
      error: "the server restarted before this finished, so it was never completed. Nothing was changed - ask again.",
      finished_at: new Date(),
    } as never)
    .where("status", "in", ["queued", "running"])
    .where("updated_at", "<", strandedBefore)
    .execute();
  await db
    .deleteFrom("core_ai_chat_turns")
    .where("status", "in", ["done", "failed"])
    .where("finished_at", "<", dayAgo)
    .execute();
}
