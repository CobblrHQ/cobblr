// A label on this person's own print queue, by id or by its caption.
import type { Kysely } from "kysely";
import type { LabelsDB } from "../db.js";

export async function findQueued(db: Kysely<LabelsDB>, userId: string, named: unknown) {
  const want = typeof named === "string" ? named.trim() : "";
  const rows = await db.selectFrom("labels_queue").select(["id", "description", "qty"]).where("user_id", "=", userId).execute();
  if (!rows.length) return { error: "Your label queue is empty." };
  if (!want) return rows.length === 1 ? rows[0]! : { error: `Say which label: ${rows.map((r) => r.description || "(no caption)").join(", ")}.` };
  const hit = rows.filter((r) => r.id === want || (r.description ?? "").toLowerCase() === want.toLowerCase());
  if (hit.length === 1) return hit[0]!;
  return { error: hit.length ? `More than one queued label says "${want}"; say which by its id.` : `No queued label says "${want}".` };
}
