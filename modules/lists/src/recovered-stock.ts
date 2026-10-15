// A line a wire put on a list because something was running low goes again
// when it is not: the count is back above its minimum (an Undo, a delivery, a
// recount). Only a line the wire added (`auto`), and only while unticked; a
// line a person added, or one somebody ticked, is theirs and stays.
import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { ListsDB } from "./db.js";

export function registerRecoveredStock(): void {
  platform().events.on("inventory.stock.recovered", "lists", async (raw) => {
    const ev = raw as { orgId?: string; partId?: string };
    if (!ev.orgId || !ev.partId) return;
    try {
      const db = (await platform().tenants.getDb(ev.orgId)) as Kysely<ListsDB>;
      const rows = await db
        .selectFrom("lists_items")
        .select("id")
        .where("checked", "=", false)
        .where(sql<boolean>`metadata->'source_ref'->>'id' = ${ev.partId}`)
        .where(sql<boolean>`metadata->>'auto' = 'true'`)
        .execute();
      for (const row of rows) {
        await platform().deletedRecords.capture(ev.orgId, "lists:item", row.id, () =>
          db.deleteFrom("lists_items").where("id", "=", row.id).where("checked", "=", false).executeTakeFirst(),
        );
      }
    } catch (err) {
      platform().health.notePassFailure("lists.recovered-stock", ev.orgId, err);
      console.error("[lists] a running-low line was not taken off:", (err as Error).message);
    }
  });
}
