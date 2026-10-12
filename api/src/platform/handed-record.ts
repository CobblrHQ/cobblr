import { sql } from "kysely";
import { meta } from "../db/meta.js";

export async function handedRecord(orgId: string, id: string) {
  return meta.selectFrom("share_offers as o").leftJoin("share_links as l", "l.id", "o.link_id")
    .select(["o.title", "o.target_org_id", "o.taken_at", "o.decided_at", sql<string>`coalesce(l.peer_name, o.transfer->>'target_name')`.as("who")])
    .where("o.direction", "=", "out").where(sql<string>`(o.source->>'org_id')`, "=", orgId).where(sql<string>`o.source->>'id'`, "=", id)
    .where((eb) => eb.or([
      eb.and([eb("o.transfer", "is", null), eb("o.status", "=", "taken")]),
      eb.and([eb(sql<string>`o.transfer->>'mode'`, "=", "move"), eb(sql<string>`o.transfer->>'source_changed'`, "=", "true"), eb(sql<string>`o.transfer->>'state'`, "in", ["landed", "complete", "undoing"]), eb("o.status", "!=", "returned")]),
    ])).executeTakeFirst();
}
