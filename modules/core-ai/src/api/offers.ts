// An offer Cobb makes is a record (migration 0015 says why).
//
// A turn's result names its offers: `{ type: "proposal", proposal }` or
// `{ type: "proposals", items: [{ summary, proposal }] }`. Each one is kept
// here when the turn ends, and the result carries its id (`offer_id`), so the
// card a reloaded page, another tab or another device draws is this record,
// and Confirm runs the plan kept here, never a copy the browser sends back.
// An offer is answered once: confirming claims it atomically, so two tabs
// pressing Confirm run it once.

import { sql, type Kysely } from "kysely";
import type { CoreAiDB, OfferStatus } from "../db.js";
import { overlaps, planTitle } from "./one-plan.js";
import { saysSomething } from "./says-something.js";

/** Offers are kept this long; a conversation older than this has moved on. */
export const OFFER_KEEP_DAYS = 30;

type Item = { summary?: unknown; proposal?: unknown; offer_id?: string };

/** Record every offer a turn's result makes, and stamp each with its id. */
export async function withOffers(
  db: Kysely<CoreAiDB>,
  userId: string,
  turnId: string | null,
  result: unknown,
): Promise<unknown> {
  // Every road a turn ends on comes through here, so this is also where a
  // turn is held to ending on words (says-something.ts), once every card it
  // carries, its own and those relayed during it, is on it.
  if (!userId || !result || typeof result !== "object") return saysSomething(result);
  // A turn that ended in an error or a build carries no cards of its own; its
  // relayed offers still ride along below.
  const out = result as Record<string, unknown>;
  const items: Item[] =
    out.type === "proposal" && out.proposal ? [out as Item] : out.type === "proposals" && Array.isArray(out.items) ? (out.items as Item[]) : [];
  for (const it of items) {
    if (!it.proposal || it.offer_id) continue;
    const row = await db
      .insertInto("core_ai_offers")
      .values({ user_id: userId, turn_id: turnId, summary: String(it.summary ?? ""), proposal: JSON.stringify(it.proposal) } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    it.offer_id = row.id;
  }
  const final = saysSomething(turnId ? await withTurnOffers(db, userId, turnId, out, items) : out) as Record<string, unknown>;
  await replaceEarlierOffers(db, userId, cardsIn(final));
  return final;
}

function cardsIn(out: Record<string, unknown>): Item[] {
  return out.type === "proposal" && out.proposal ? [out as Item] : out.type === "proposals" && Array.isArray(out.items) ? (out.items as Item[]) : [];
}

/** A card left open by an earlier message, about the same records or the
 *  same feature as a card this one made, is replaced by it: never two live
 *  Confirms for one intent. It shows as "Replaced by the plan below". */
async function replaceEarlierOffers(db: Kysely<CoreAiDB>, userId: string, fresh: Item[]): Promise<void> {
  const mine = fresh.filter((it) => it.offer_id && it.proposal);
  if (!mine.length) return;
  const open = await db
    .selectFrom("core_ai_offers")
    .select(["id", "proposal"])
    .where("user_id", "=", userId)
    .where("status", "=", "open")
    .where("made_at", ">", sql<Date>`now() - interval '1 day'`)
    .execute();
  const freshIds = new Set(mine.map((it) => it.offer_id));
  const stale = open
    .filter((o) => !freshIds.has(o.id))
    .filter((o) => {
      const p = typeof o.proposal === "string" ? JSON.parse(o.proposal) : o.proposal;
      return mine.some((it) => overlaps(it.proposal, p));
    })
    .map((o) => o.id);
  if (!stale.length) return;
  await db
    .updateTable("core_ai_offers")
    .set({ status: "replaced", answered_at: sql`now()` } as never)
    .where("user_id", "=", userId)
    .where("status", "=", "open")
    .where("id", "in", stale)
    .execute();
}

/** The offers made DURING a turn (an assistant on a bridge offering a change
 *  through the relay, mid-answer) ride the turn's result as cards, after
 *  whatever it already carries: the same card the built-in path draws. */
async function withTurnOffers(
  db: Kysely<CoreAiDB>,
  userId: string,
  turnId: string,
  out: Record<string, unknown>,
  carried: Item[],
): Promise<Record<string, unknown>> {
  const have = new Set(carried.map((it) => it.offer_id).filter(Boolean));
  const made = (
    await db
      .selectFrom("core_ai_offers")
      .select(["id", "summary", "proposal"])
      .where("user_id", "=", userId)
      .where("turn_id", "=", turnId)
      .where("status", "=", "open")
      .orderBy("made_at", "asc")
      .execute()
  ).filter((r) => !have.has(r.id));
  if (!made.length) return out;
  const extra: Item[] = made.map((r) => ({
    summary: r.summary,
    proposal: typeof r.proposal === "string" ? JSON.parse(r.proposal) : r.proposal,
    offer_id: r.id,
  }));
  const before = out.type === "proposal" && out.proposal ? [{ summary: out.summary, proposal: out.proposal, offer_id: out.offer_id } as Item] : out.type === "proposals" ? carried : [];
  const all = [...before, ...extra];
  const merged: Record<string, unknown> = { ...out };
  delete merged.proposal;
  delete merged.summary;
  delete merged.offer_id;
  delete merged.items;
  if (all.length === 1) return { ...merged, type: "proposal", summary: all[0]!.summary, proposal: all[0]!.proposal, offer_id: all[0]!.offer_id };
  // One request, one plan (one-plan.ts): the cards offered during the turn
  // become the steps of one card, in the order they were offered, and the
  // separate offers are replaced by it, so none of them can run on its own.
  const steps = all.map((it) => ({ summary: String(it.summary ?? ""), proposal: it.proposal, undoable: null }));
  const title = planTitle(steps.map((x) => x.summary));
  const plan = { kind: "plan", title, steps };
  const row = await db
    .insertInto("core_ai_offers")
    .values({ user_id: userId, turn_id: turnId, summary: title, proposal: JSON.stringify(plan) } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  const parts = all.map((it) => it.offer_id).filter((x): x is string => !!x);
  if (parts.length) {
    await db
      .updateTable("core_ai_offers")
      .set({ status: "replaced", answered_at: sql`now()` } as never)
      .where("user_id", "=", userId)
      .where("status", "=", "open")
      .where("id", "in", parts)
      .execute();
  }
  return { ...merged, type: "proposal", summary: title, proposal: plan, offer_id: row.id };
}

export interface OfferState {
  id: string;
  summary: string;
  proposal: unknown;
  status: OfferStatus;
  outcome: unknown | null;
}

/** The person's own offers, by id. */
export async function readOffers(db: Kysely<CoreAiDB>, userId: string, ids: string[]): Promise<OfferState[]> {
  const wanted = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i)).slice(0, 200);
  if (!wanted.length) return [];
  const rows = await db
    .selectFrom("core_ai_offers")
    .select(["id", "summary", "proposal", "status", "outcome"])
    .where("user_id", "=", userId)
    .where("id", "in", wanted)
    .execute();
  return rows.map((r) => ({ ...r, status: r.status as OfferStatus }));
}

/** Claim an open offer for running: the one atomic step that makes two
 *  presses one run. Null when it is not this person's or not open. */
export async function claimOffer(db: Kysely<CoreAiDB>, userId: string, id: string): Promise<OfferState | null> {
  const row = await db
    .updateTable("core_ai_offers")
    .set({ status: "confirming" } as never)
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("status", "=", "open")
    .returning(["id", "summary", "proposal", "status", "outcome"])
    .executeTakeFirst();
  return row ? { ...row, status: row.status as OfferStatus } : null;
}

/** What became of a claimed or open offer. */
export async function answerOffer(
  db: Kysely<CoreAiDB>,
  userId: string,
  id: string,
  status: Exclude<OfferStatus, "open" | "confirming">,
  outcome: unknown,
  from: OfferStatus[] = ["confirming"],
): Promise<boolean> {
  const r = await db
    .updateTable("core_ai_offers")
    .set({ status, outcome: outcome === undefined ? null : JSON.stringify(outcome), answered_at: new Date() } as never)
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("status", "in", from)
    .executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0) > 0;
}

/** Offers older than the keep window go. Called beside the turn sweep. */
export async function sweepOffers(db: Kysely<CoreAiDB>): Promise<void> {
  await db
    .deleteFrom("core_ai_offers")
    .where("made_at", "<", sql<Date>`now() - (${OFFER_KEEP_DAYS} || ' days')::interval`)
    .execute();
}

/** The person's conversation, as the panel keeps it (its own shape). */
export async function readConversation(db: Kysely<CoreAiDB>, userId: string): Promise<{ messages: unknown[]; updated_at: string } | null> {
  const row = await db.selectFrom("core_ai_conversations").select(["messages", "updated_at"]).where("user_id", "=", userId).executeTakeFirst();
  if (!row) return null;
  const messages = typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages;
  return { messages: Array.isArray(messages) ? messages : [], updated_at: new Date(row.updated_at).toISOString() };
}

export async function writeConversation(db: Kysely<CoreAiDB>, userId: string, messages: unknown[]): Promise<string> {
  const now = new Date();
  await db
    .insertInto("core_ai_conversations")
    .values({ user_id: userId, messages: JSON.stringify(messages), updated_at: now } as never)
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ messages: JSON.stringify(messages), updated_at: now } as never))
    .execute();
  return now.toISOString();
}

/** Why an offer cannot be confirmed now, in a sentence. */
export function offerAnsweredSentence(status: OfferStatus): string {
  switch (status) {
    case "confirmed":
      return "That was already confirmed.";
    case "confirming":
      return "That is being done already.";
    case "cancelled":
      return "That was cancelled. Ask again if you still want it.";
    case "replaced":
      return "A newer plan replaced that one.";
    case "failed":
      return "That was tried and did not go through. Ask again.";
    default:
      return "That cannot be confirmed now.";
  }
}
