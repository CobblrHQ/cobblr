// The printer pool a person named, by name or id. Shared by the pool actions.
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { poolGroupCondition } from "../pool-groups.js";

export async function findPool(db: Kysely<DigifabDB>, named: unknown): Promise<{ id: string; name: string } | { error: string }> {
  const want = typeof named === "string" ? named.trim() : "";
  if (!want) return { error: "Say which pool." };
  const rows = await db.selectFrom("digifab_pools").where(poolGroupCondition() as never).select(["id", "name"]).execute();
  const hit = rows.filter((r) => r.id === want || r.name.toLowerCase() === want.toLowerCase());
  if (hit.length === 1) return hit[0]!;
  if (hit.length > 1) return { error: `More than one pool is called "${want}". Say which by its id.` };
  return { error: rows.length ? `No pool called "${want}". There is ${rows.map((r) => r.name).join(", ")}.` : "There are no printer pools yet." };
}
