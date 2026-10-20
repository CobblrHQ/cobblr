// Every change to the share outbox's rows locks them in one order, by id.
//
// A flush marks what it sent while Sync now pulls every waiting change forward
// and a revoke drops what is left: statements over the same rows, from
// different requests and processes. An UPDATE locks rows as its plan reads
// them, and a plan reads a heap in its physical order, which an update has
// already shuffled; two statements reading the same rows in opposite orders
// deadlocked, and the owner's Sync now answered 500 "deadlock detected"
// (#7036). Taking the locks in id order first makes any two of them queue.

import type { Updateable } from "kysely";
import { meta } from "../db/meta.js";
import type { MetaDB } from "../db/schema.js";

const outboxIds = () => meta.selectFrom("share_outbox").select("id");
type OutboxIds = ReturnType<typeof outboxIds>;
type OutboxSet = Updateable<MetaDB["share_outbox"]>;

/** The outbox rows `where` picks, locked in id order. */
function lockedInIdOrder(where: (q: OutboxIds) => OutboxIds) {
  return where(outboxIds()).orderBy("id").forUpdate();
}

/** Change the outbox rows `where` picks. */
export function outboxUpdate(where: (q: OutboxIds) => OutboxIds, set: OutboxSet) {
  return meta.updateTable("share_outbox").set(set).where("id", "in", lockedInIdOrder(where));
}

/** Remove the outbox rows `where` picks. */
export function outboxDelete(where: (q: OutboxIds) => OutboxIds) {
  return meta.deleteFrom("share_outbox").where("id", "in", lockedInIdOrder(where));
}
