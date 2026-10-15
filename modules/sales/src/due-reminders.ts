// An order's due date reminds the shop (#6671): the day before it is wanted
// ("due tomorrow") and once it has passed undelivered ("late"), each once per
// due date. A job shop's orders are its due dates; a date nobody is told about
// is a date that gets missed.
//
// Open orders only: confirmed (being made) and fulfilled (ready, not yet with
// the customer). A quote promises nothing and a delivered or cancelled order
// is done. Moving the due date re-arms the reminder for the new one.
//
// "Today" is the day that has arrived everywhere (the platform has no
// workspace time zone yet), so a reminder can come a few hours late but never
// a day early: the same rule maintenance's due dates follow.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { arrivedEverywhere, daysUntil } from "@cobblr/platform-contract/day";
import type { SalesDB } from "./db.js";

export const DUE_PASS = "sales.order-due";
export const DUE_EVENT = "sales.order.due";
const HOUR_MS = 3_600_000;

export type DueState = "soon" | "late";

/** Which reminder an order due on `due` is owed today, if any. */
export function dueState(due: string, today: string): DueState | null {
  const days = daysUntil(due, today);
  if (days < 0) return "late";
  if (days <= 1) return "soon";
  return null;
}

/** The sentence a reminder says, in the shop's words. */
export function dueWords(o: { order_number: string | null; customer_name: string | null }, due: string, today: string): string {
  const which = `${o.order_number || "An order"}${o.customer_name ? ` for ${o.customer_name}` : ""}`;
  const days = daysUntil(due, today);
  if (days < 0) return `${which} is ${-days} day${days === -1 ? "" : "s"} late. It was wanted ${due}.`;
  return `${which} is due ${days === 0 ? "today" : "tomorrow"}.`;
}

/** One workspace: every open order owed a reminder it has not had, told to
 *  the kind's audience in one notice (one order: its sentence and its page;
 *  several: each on its own line, and the orders list). */
export async function remindDue(db: Kysely<SalesDB>, orgId: string, now: Date): Promise<{ reminded: number }> {
  const today = arrivedEverywhere(now);
  const rows = await db
    .selectFrom("sales_orders")
    .select(["id", "order_number", "customer_name", "due_date", "due_reminded_for", "due_reminded_state"])
    .where("status", "in", ["confirmed", "fulfilled"])
    .where("due_date", "is not", null)
    .where("due_date", "<=", sql<string>`(${today}::date + 1)`)
    .orderBy("due_date", "asc")
    .execute();
  const owed: Array<{ id: string; due: string; state: DueState; line: string }> = [];
  for (const o of rows) {
    const due = o.due_date!;
    const state = dueState(due, today);
    if (!state) continue;
    if (o.due_reminded_for === due && (o.due_reminded_state === state || o.due_reminded_state === "late")) continue;
    // Claim it first, so two walks at once tell nobody twice.
    const claimed = await db
      .updateTable("sales_orders")
      .set({ due_reminded_for: due, due_reminded_state: state })
      .where("id", "=", o.id)
      .where((eb) => eb.or([eb("due_reminded_for", "is", null), eb("due_reminded_for", "!=", due), eb("due_reminded_state", "!=", state)]))
      .returning("id")
      .executeTakeFirst();
    if (claimed) owed.push({ id: o.id, due, state, line: dueWords(o, due, today) });
  }
  if (owed.length === 0) return { reminded: 0 };
  const only = owed.length === 1 ? owed[0]! : null;
  const link = only ? await platform().entities.recordAddressForEntity(orgId, "sales:order", only.id) : "/sales";
  const message = only ? only.line : `Orders that need you:\n${owed.map((o) => o.line).join("\n")}`;
  const key = owed.map((o) => `${o.id}:${o.due}:${o.state}`).join(",");
  for (const userId of await platform().notifications.audienceFor(orgId, DUE_EVENT)) {
    // dispatch-per-row-ok: one notice per person for the whole round; userId only varies the address and deduplication key.
    await platform().notifications.dispatch({
      orgId, userId, eventType: DUE_EVENT, module: "sales",
      ...(only ? { entityType: "order", entityId: only.id } : {}),
      // Due on a date, knowable in advance: the morning brief, not a ping.
      triggeredBy: "schedule",
      idempotencyKey: `sales-order-due:${key}:${userId}`.slice(0, 500),
      message,
      ...(link ? { link_url: link } : { no_link_reason: "The order has no registered page." }),
    });
  }
  return { reminded: owed.length };
}

/** The hourly visit, on the kernel's sweep (one walk, one connection budget). */
export function registerDueSweep(): void {
  platform().sweeps.register({
    name: DUE_PASS,
    everyMs: HOUR_MS,
    module: "sales",
    visit: async ({ orgId, db, now }) => {
      try {
        return await remindDue(db as Kysely<SalesDB>, orgId, now);
      } catch (err) {
        // A workspace whose sales migrations have not caught up yet.
        if (!(err as Error).message.includes("does not exist")) throw err;
        return { reminded: 0 };
      }
    },
  });
}
