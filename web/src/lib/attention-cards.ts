// The "needs you" feed, as the dashboard shows it: one card per collection
// for everything dated in it, beside the feed's other rows.
//
// The feed answers in rows (overdue in Groceries, coming up in Groceries),
// and the assistant reads it that way. On the dashboard the two were two
// cards for one question, each with its own collapse and arrow (the owner,
// 2026-09-28): "22 overdue in Groceries" above "4 coming up in Groceries".
// This folds a collection's dated rows into one card, placed where its most
// urgent row was, and leaves every other row as it is.

import type { AttentionFeedItem } from "./api";

export type DatedGroup = AttentionFeedItem & { collection: NonNullable<AttentionFeedItem["collection"]> };

export interface DatedCardModel {
  type: "dated";
  collection: NonNullable<AttentionFeedItem["collection"]>;
  overdue: DatedGroup | null;
  today: DatedGroup | null;
  upcoming: DatedGroup | null;
}

export type AttentionCard = DatedCardModel | { type: "row"; item: AttentionFeedItem };

const DATED = new Set(["overdue", "due_today", "upcoming"]);

export function composeAttention(items: readonly AttentionFeedItem[]): AttentionCard[] {
  const out: AttentionCard[] = [];
  const byKey = new Map<string, DatedCardModel>();
  for (const it of items) {
    if (!it.collection || !DATED.has(it.kind)) {
      out.push({ type: "row", item: it });
      continue;
    }
    let card = byKey.get(it.collection.key);
    if (!card) {
      card = { type: "dated", collection: it.collection, overdue: null, today: null, upcoming: null };
      byKey.set(it.collection.key, card);
      out.push(card);
    }
    const slot = it.kind === "overdue" ? "overdue" : it.kind === "due_today" ? "today" : "upcoming";
    card[slot] = it as DatedGroup;
  }
  return out;
}

/** The words for a card's counts: "22 overdue · 1 today · 4 coming up". A
 *  drink-by that has passed is past its best, not overdue. */
export function datedCounts(card: DatedCardModel): string {
  const late = card.collection.due === "window" ? "past their best" : "overdue";
  const lateOne = card.collection.due === "window" ? "past its best" : "overdue";
  return [
    card.overdue ? `${card.overdue.count} ${card.overdue.count === 1 ? lateOne : late}` : null,
    card.today ? `${card.today.count} today` : null,
    card.upcoming ? `${card.upcoming.count} coming up` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
