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
// DONE WHEN measured in heal_shim_runs, and it runs after the api listens: a
// week-old mark used to sweep inline, and on 2026-10-29 two passes whose marks
// aged out together held staging's new api past its 300 s roll limit (1,571
// workspaces, 234 s for one pass). lint:heal-shims holds every shim that opens
// a tenant pool to this gate.
//
// So does a pass whose code changed, or one a workspace failed: once a pass
// has a mark at all, its next full run comes after listen. The same night a
// change to a shim's own text (the gate call, #8917) re-armed a 4,756-workspace
// sweep inline, a killed roll never wrote its mark, and every retry swept
// again from the start. Only a pass that has never swept here runs before
// listen, which is a fresh database: nothing there to walk.
import { createHash } from "node:crypto";
import { meta } from "../db/meta.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The version of a sweep: a hash of the functions and SQL it runs. */
export function sweepVersion(...parts: Array<string | ((...args: never[]) => unknown)>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "function" ? p.toString() : p).update("\0");
  return h.digest("hex").slice(0, 16);
}

const afterListen = new Map<string, () => Promise<unknown>>();
let rerunning: string | null = null;

/** True when the boot may skip this sweep: it has a mark. A mark at another
 *  version (the pass changed, or a workspace failed) or a week old queues
 *  `rerun` for runSweepsAfterListen. Only a pass never swept here, or a mark
 *  it cannot read, sweeps before listen. Never throws. */
export async function sweptClean(
  pass: string,
  version: string,
  rerun: () => Promise<unknown>,
  now: Date = new Date(),
): Promise<boolean> {
  if (rerunning === pass) return false;
  try {
    const row = await meta
      .selectFrom("boot_sweep_marks")
      .select(["version", "swept_at"])
      .where("pass", "=", pass)
      .executeTakeFirst();
    if (!row) return false;
    if (row.version !== version || now.getTime() - new Date(row.swept_at).getTime() >= WEEK_MS) afterListen.set(pass, rerun);
    return true;
  } catch (err) {
    console.warn(`[boot-sweep] could not read the mark for ${pass}; sweeping:`, (err as Error).message);
    return false;
  }
}

/** Record a finished sweep. Only a sweep where no workspace failed counts as
 *  clean: one it could not read still has its work ahead of it, so its mark
 *  names no version and the next boot runs it again after listen. Never throws. */
export async function markSwept(pass: string, version: string, failed: number, now: Date = new Date()): Promise<void> {
  if (failed > 0) version = `failed:${failed}`;
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

/** The passes whose clean mark is a week old, waiting for the api to listen. */
export function sweepsAfterListen(): string[] {
  return [...afterListen.keys()];
}

/** Run each week-old sweep in full, one at a time, once the api is serving. */
export async function runSweepsAfterListen(): Promise<void> {
  for (const [pass, rerun] of afterListen) {
    afterListen.delete(pass);
    rerunning = pass;
    try {
      await rerun();
    } catch (err) {
      console.warn(`[boot-sweep] the weekly run of ${pass} failed:`, (err as Error).message);
    } finally {
      rerunning = null;
    }
  }
}
