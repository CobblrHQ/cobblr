// What a mailbox check found, for the review (#5462): per year and store, how
// each email was decided and what it would file; the likely misses (Gmail
// called it a purchase and the rules did not) and the likely false hits
// (filed on one weak cue); and how this run differs from the one before.

import { sql } from "kysely";
import { meta } from "../../db/meta.js";

export type ReviewList = "misses" | "false-hits" | "ask-ai" | "orders" | "all";

export interface CheckSummary {
  id: string;
  status: string;
  query: string;
  seen: number;
  pages: number;
  started_at: Date;
  finished_at: Date | null;
  last_error: string | null;
  totals: Record<string, number>;
  by: Record<string, number>;
  /** The run before this one on the same mailbox, verdict by verdict. */
  previous: { id: string; totals: Record<string, number> } | null;
}

async function totalsOf(checkId: string): Promise<{ totals: Record<string, number>; by: Record<string, number> }> {
  const rows = await meta
    .selectFrom("mailbox_check_items")
    .select(["verdict", "decided_by", sql<number>`count(*)::int`.as("n")])
    .where("check_id", "=", checkId)
    .groupBy(["verdict", "decided_by"])
    .execute();
  const totals: Record<string, number> = {};
  const by: Record<string, number> = {};
  for (const r of rows) {
    totals[r.verdict] = (totals[r.verdict] ?? 0) + r.n;
    by[r.decided_by] = (by[r.decided_by] ?? 0) + r.n;
  }
  return { totals, by };
}

export async function checkSummary(checkId: string): Promise<CheckSummary | null> {
  const c = await meta.selectFrom("mailbox_checks").selectAll().where("id", "=", checkId).executeTakeFirst();
  if (!c) return null;
  const { totals, by } = await totalsOf(checkId);
  const prev = await meta
    .selectFrom("mailbox_checks")
    .select("id")
    .where("credential_id", "=", c.credential_id)
    .where("started_at", "<", c.started_at)
    .orderBy("started_at", "desc")
    .executeTakeFirst();
  return {
    id: c.id,
    status: c.status,
    query: c.query,
    seen: c.seen,
    pages: c.pages,
    started_at: c.started_at,
    finished_at: c.finished_at,
    last_error: c.last_error,
    totals,
    by,
    previous: prev ? { id: prev.id, totals: (await totalsOf(prev.id)).totals } : null,
  };
}

/** Per year and store: candidates, what each was decided as, and by what. */
export async function checkByYearAndStore(checkId: string) {
  return meta
    .selectFrom("mailbox_check_items")
    .select([
      sql<number>`extract(year from received_at)::int`.as("year"),
      sql<string>`coalesce(sender_domain, 'unknown')`.as("store"),
      sql<number>`count(*)::int`.as("candidates"),
      sql<number>`(count(*) filter (where verdict = 'order'))::int`.as("orders"),
      sql<number>`(count(*) filter (where verdict = 'shipment'))::int`.as("shipments"),
      sql<number>`(count(*) filter (where verdict = 'not-order'))::int`.as("not_orders"),
      sql<number>`(count(*) filter (where verdict = 'ask-ai'))::int`.as("ask_ai"),
      sql<number>`(count(*) filter (where decided_by = 'schema.org'))::int`.as("by_schema"),
      sql<number>`(count(*) filter (where decided_by = 'platform'))::int`.as("by_platform"),
      sql<number>`(count(*) filter (where decided_by = 'heuristics'))::int`.as("by_heuristics"),
      sql<number>`(count(*) filter (where decided_by = 'remembered'))::int`.as("by_remembered"),
    ])
    .where("check_id", "=", checkId)
    .groupBy([sql`extract(year from received_at)`, sql`coalesce(sender_domain, 'unknown')`])
    .orderBy(sql`extract(year from received_at)`, "desc")
    .orderBy(sql`count(*)`, "desc")
    .execute();
}

/** One review list, newest first. */
export async function checkItems(checkId: string, list: ReviewList, limit: number, offset: number) {
  let q = meta
    .selectFrom("mailbox_check_items")
    .select(["gmail_id", "received_at", "sender", "sender_domain", "subject", "purchases_label", "verdict", "decided_by", "strength", "platform", "found", "person_verdict", sql<number>`count(*) over()`.as("total")])
    .where("check_id", "=", checkId);
  if (list === "misses") q = q.where("purchases_label", "=", true).where("verdict", "in", ["not-order", "ask-ai"]);
  else if (list === "false-hits") q = q.where("verdict", "in", ["order", "shipment"]).where("strength", "=", "weak");
  else if (list === "ask-ai") q = q.where("verdict", "=", "ask-ai");
  else if (list === "orders") q = q.where("verdict", "in", ["order", "shipment"]);
  const rows = await q.orderBy("received_at", "desc").limit(limit).offset(offset).execute();
  return { items: rows.map(({ total: _t, ...r }) => r), total: rows[0]?.total ?? 0 };
}

/** A person's "is / isn't an order" on one message: kept on the message, and
 *  remembered for its sender, so the next check (and the live read, once it
 *  is on) takes it before any rule. */
export async function recordVerdict(checkId: string, userId: string, gmailId: string, isOrder: boolean): Promise<{ sender_domain: string | null } | null> {
  const item = await meta
    .updateTable("mailbox_check_items")
    .set({ person_verdict: isOrder ? "order" : "not-order" })
    .where("check_id", "=", checkId)
    .where("gmail_id", "=", gmailId)
    .returning(["sender_domain"])
    .executeTakeFirst();
  if (!item) return null;
  if (item.sender_domain) {
    await meta
      .insertInto("mailbox_sender_verdicts")
      .values({ user_id: userId, sender_domain: item.sender_domain, verdict: isOrder ? "order" : "not-order" })
      .onConflict((oc) => oc.columns(["user_id", "sender_domain"]).doUpdateSet({ verdict: isOrder ? "order" : "not-order", set_at: new Date() }))
      .execute();
  }
  return { sender_domain: item.sender_domain };
}

/** Every message a person marked, with the signals the rules saw: what a
 *  test fixture is made from. No body: the signals are the fixture. */
export async function markedForFixtures(checkId: string) {
  return meta
    .selectFrom("mailbox_check_items")
    .select(["sender_domain", "subject", "received_at", "purchases_label", "verdict", "decided_by", "strength", "platform", "found", "person_verdict"])
    .where("check_id", "=", checkId)
    .where("person_verdict", "is not", null)
    .orderBy("received_at", "desc")
    .execute();
}
