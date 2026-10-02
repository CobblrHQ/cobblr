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
  for (;;) {
    try {
      await ping();
      if (lastSaid > -Infinity) log(`[boot] the database answered after ${Math.round((now() - start) / 1000)}s`);
      return;
    } catch (err) {
      if (!isDatabaseStarting(err)) throw err;
      const waited = now() - start;
      if (waited >= opts.ceilingMs) {
        throw new Error(
          `[boot] the database was still not answering after ${Math.round(waited / 1000)}s (ceiling ${Math.round(opts.ceilingMs / 1000)}s, COBBLR_BOOT_DB_WAIT_MS): ${describe(err)}`,
        );
      }
      if (now() - lastSaid >= sayEvery) {
        log(`[boot] waiting for the database (crash recovery / starting): ${describe(err)}`);
        lastSaid = now();
      }
      await sleep(Math.min(delay, Math.max(0, opts.ceilingMs - waited)));
      delay = Math.min(delay * 2, 5_000);
    }
  }
}
