// A job or a print file the person named: by id, or by its file name when that
// picks out one. Shared by the job and library actions.
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findJob(db: Kysely<DigifabDB>, named: unknown): Promise<{ id: string; file_ref: string; status: string; priority: number; max_attempts: number } | { error: string }> {
  const want = typeof named === "string" ? named.trim() : "";
  if (!want) return { error: "Say which job." };
  const cols = ["id", "file_ref", "status", "priority", "max_attempts"] as const;
  if (UUID.test(want)) {
    const row = await db.selectFrom("digifab_jobs").select(cols).where("id", "=", want).executeTakeFirst();
    return row ?? { error: "There is no such job." };
  }
  const rows = (await db.selectFrom("digifab_jobs").select(cols).orderBy("created_at", "desc").limit(500).execute()).filter((r) => r.file_ref.toLowerCase() === want.toLowerCase());
  if (rows.length === 1) return rows[0]!;
  if (rows.length > 1) return { error: `More than one job prints "${want}". Say which by its id.` };
  return { error: `No job prints "${want}".` };
}

export async function findPrintFile(db: Kysely<DigifabDB>, named: unknown): Promise<{ id: string; name: string; notes: string | null } | { error: string }> {
  const want = typeof named === "string" ? named.trim() : "";
  if (!want) return { error: "Say which file." };
  const rows = await db.selectFrom("digifab_library").select(["id", "name", "notes"]).execute();
  const hit = rows.filter((r) => r.id === want || r.name.toLowerCase() === want.toLowerCase());
  if (hit.length === 1) return hit[0]!;
  if (hit.length > 1) return { error: `More than one file is called "${want}". Say which by its id.` };
  return { error: `No file called "${want}" is in the print library.` };
}
