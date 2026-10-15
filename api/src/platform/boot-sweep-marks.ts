// A per-workspace boot sweep that has already run clean skips itself.
//
// A historical shim that opens every workspace's database finds nothing once
// its work is done, yet it kept opening one tenant pool per workspace on every
// boot: on staging, four of them cost about four minutes before the api could
// listen (#6707). Its work cannot regrow: the writer is fixed, or the pass's
// BORN WITH twin makes each new workspace right. So a sweep that finished with
// no workspace failing records the version of its own code, and the next boot
// skips it while that version is current and the mark is under a week old.
//
// The version is a hash of the pass's own source, so changing the pass re-arms
// it without anyone remembering to. The weekly full run keeps the shim's
// DONE WHEN measured in heal_shim_runs. lint:heal-shims holds every shim that
// opens a tenant pool to this gate.
import { createHash } from "node:crypto";
import { meta } from "../db/meta.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The version of a sweep: a hash of the functions and SQL it runs. */
export function sweepVersion(...parts: Array<string | ((...args: never[]) => unknown)>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "function" ? p.toString() : p).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** True when this sweep ran clean at this version within the last week, so
 *  the boot may skip it. Never throws: a mark it cannot read means sweep. */
export async function sweptClean(pass: string, version: string, now: Date = new Date()): Promise<boolean> {
  try {
    const row = await meta
      .selectFrom("boot_sweep_marks")
      .select(["version", "swept_at"])
      .where("pass", "=", pass)
      .executeTakeFirst();
    if (!row || row.version !== version) return false;
    return now.getTime() - new Date(row.swept_at).getTime() < WEEK_MS;
  } catch (err) {
    console.warn(`[boot-sweep] could not read the mark for ${pass}; sweeping:`, (err as Error).message);
    return false;
  }
}

/** Record a finished sweep. Only a sweep where no workspace failed counts:
 *  one it could not read still has its work ahead of it. Never throws. */
export async function markSwept(pass: string, version: string, failed: number, now: Date = new Date()): Promise<void> {
  if (failed > 0) {
    await meta.deleteFrom("boot_sweep_marks").where("pass", "=", pass).execute().catch(() => {});
    return;
  }
  try {
    await meta
      .insertInto("boot_sweep_marks")
      .values({ pass, version, swept_at: now })
      .onConflict((oc) => oc.column("pass").doUpdateSet({ version, swept_at: now }))
      .execute();
  } catch (err) {
    console.warn(`[boot-sweep] could not mark ${pass} swept:`, (err as Error).message);
  }
}
