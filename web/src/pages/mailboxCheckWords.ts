// The sentences a mailbox check reads as (#5462). Pure.

import { withArticle } from "@cobblr/platform-contract/plural";
import type { MailboxCheck, MailboxCheckItem } from "../lib/api";

const n = (x: number | undefined) => x ?? 0;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function mailboxCheckWords(c: MailboxCheck): { progress: string; delta: string | null; decidedBy: string } {
  const t = c.totals;
  const tally = `${plural(n(t.order), "order")}, ${plural(n(t.shipment), "parcel")}, ${plural(n(t["not-order"]), "not an order", "not orders")}, ${n(t["ask-ai"])} would ask AI`;
  const progress =
    c.status === "running"
      ? `Checking: ${plural(c.seen, "email")} read so far. ${tally}.`
      : c.status === "done"
        ? `Done: ${plural(c.seen, "email")} checked. ${tally}.`
        : c.status === "stopped"
          ? `Stopped after ${plural(c.seen, "email")}. ${tally}.`
          : `Stopped by a problem after ${plural(c.seen, "email")}. ${tally}.`;
  let delta: string | null = null;
  if (c.previous && c.status !== "running") {
    const p = c.previous.totals;
    const diff = (k: string, word: string) => {
      const d = n(t[k]) - n(p[k]);
      return d === 0 ? null : `${d > 0 ? "+" : ""}${d} ${word}`;
    };
    const parts = [diff("order", "orders"), diff("shipment", "parcels"), diff("not-order", "not orders"), diff("ask-ai", "would ask AI")].filter(Boolean);
    delta = parts.length ? `Since the last check: ${parts.join(", ")}.` : "Same as the last check.";
  }
  const by = c.by;
  const decidedBy = `Decided by markup ${n(by["schema.org"])}, by store platform ${n(by.platform)}, by rules ${n(by.heuristics)}, by your verdicts ${n(by.remembered)}.`;
  return { progress, delta, decidedBy };
}

export function verdictWord(it: Pick<MailboxCheckItem, "verdict" | "decided_by" | "platform">): string {
  const what = it.verdict === "order" ? "would file as an order" : it.verdict === "shipment" ? "would file as a parcel" : it.verdict === "ask-ai" ? "would ask AI" : "not an order";
  const how =
    it.decided_by === "schema.org" ? "from its markup" : it.decided_by === "platform" ? `as ${withArticle(`${it.platform ?? "store"} email`)}` : it.decided_by === "heuristics" ? "by the rules" : it.decided_by === "remembered" ? "by your verdict" : "nothing decided it";
  return `${what}, ${how}`;
}
