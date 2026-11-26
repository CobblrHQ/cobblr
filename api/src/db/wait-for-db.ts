// Boot waits for a database that is still starting, and refuses one that is wrong.
//
// After a power cut the db container comes back first and spends minutes in
// crash recovery: connections are refused, then answered with 57P03 "the
// database system is starting up". The api's boot pinged once and exited 1,
// so docker restarted it in a loop (18 times on the dev rig, 2026-09-23) and a
// rig alert said "manual fix needed" for a box that only needed to wait. The
// same happens on any box whose db is slower than the api to come up.
//
// So a database that is STARTING (57P03, a refused connection, a name that
// does not resolve yet) is waited for, with backoff, saying so every ~15 s, up
// to a ceiling. Anything else (a wrong password, a database that does not
// exist, a bad URL) is a misconfiguration and fails at once, loud and named:
// recovery is never a reason to hide one.
//
// RECOVERY HAS NO CEILING (2026-11-26, the A6's power cut): the dev database
// spent over 35 minutes in its start-up fsync (598 databases, 536,525 files)
// answering 57P03 the whole time, and the api gave up at the 600 s ceiling
// three times and was restarted into the same wait. 57P03 is a server that is
// up and recovering; it ends when recovery ends. So the ceiling counts only
// the time the database could not be reached at all (refused, not resolving),
// and a 57P03 wait goes on, still said every ~15 s.

/** Errors that mean "not up yet", never "wrong". */
const STARTING_CODES = new Set(["57P03", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export function isDatabaseStarting(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && STARTING_CODES.has(code);
}

export interface WaitOptions {
  /** Give up after this long, with the last error named. */
  ceilingMs: number;
  /** How often to say it is still waiting. */
  sayEveryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** The boot ceiling: COBBLR_BOOT_DB_WAIT_MS, or ten minutes. `||` so an empty
 *  value from compose falls back (docs/architecture/platform-spec.md §14.6). */
export function bootDbWaitMs(): number {
  return Number(process.env.COBBLR_BOOT_DB_WAIT_MS) || 600_000;
}

function describe(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  return [e?.code, e?.message].filter((x) => typeof x === "string" && x).join(" ") || String(err);
}

/** Run `ping` until it answers. A starting database is waited for; any other
 *  error is thrown at once, unchanged. */
export async function waitForDatabase(ping: () => Promise<unknown>, opts: WaitOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.log(line));
  const sayEvery = opts.sayEveryMs ?? 15_000;
  const start = now();
  let lastSaid = -Infinity;
  let delay = 250;
  // Time the database could not be reached at all: only this counts against the ceiling.
  let unreachable = 0;
  let last = start;
  let lastRecovering = false;
  for (;;) {
    try {
      await ping();
      if (lastSaid > -Infinity) log(`[boot] the database answered after ${Math.round((now() - start) / 1000)}s`);
      return;
    } catch (err) {
      if (!isDatabaseStarting(err)) throw err;
      const t = now();
      if (!lastRecovering) unreachable += t - last;
      last = t;
      const recovering = (err as { code?: unknown }).code === "57P03";
      lastRecovering = recovering;
      if (!recovering && unreachable >= opts.ceilingMs) {
        throw new Error(
          `[boot] the database was still not answering after ${Math.round(unreachable / 1000)}s unreachable (ceiling ${Math.round(opts.ceilingMs / 1000)}s, COBBLR_BOOT_DB_WAIT_MS): ${describe(err)}`,
        );
      }
      if (t - lastSaid >= sayEvery) {
        log(
          recovering
            ? `[boot] waiting for the database (crash recovery, no ceiling while it recovers, ${Math.round((t - start) / 1000)}s so far): ${describe(err)}`
            : `[boot] waiting for the database (crash recovery / starting): ${describe(err)}`,
        );
        lastSaid = t;
      }
      await sleep(recovering ? delay : Math.min(delay, Math.max(0, opts.ceilingMs - unreachable)));
      delay = Math.min(delay * 2, 5_000);
    }
  }
}
