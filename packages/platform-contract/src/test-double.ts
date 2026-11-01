// The platform() a unit test stands in for (#8966). A test that mocked
// platform() by hand built the object it needed, member by member, so a
// kernel primitive added later was missing from every one of them: an entries
// list that started to fan out through platform().db.fanOut threw inside a
// test's mock and answered an HTML error page, and nothing said why. A test
// hands its parts here instead, and every primitive that has a working stand-in
// arrives with it: add the next one to DEFAULTS, once.
import { mapLimit } from "@cobblr/platform-contract/map-limit";
import type { Platform } from "./platform.js";

/** As many branches as a server's pool of five leaves a fan-out. */
const FAN_OUT_SHARE = 3;

const DEFAULTS = {
  db: {
    fanOut: <T, R>(_orgId: string, items: readonly T[], fn: (item: T, i: number) => Promise<R>) => mapLimit(items, FAN_OUT_SHARE, fn),
  },
};

/** A platform() for a test: its own parts, over the stand-ins every test gets.
 *  A namespace the test gives keeps the stand-ins it did not name. The parts
 *  are filled in place and handed back, so a test that keeps its fake and
 *  changes it later (setPlatform(fake), then fake.entities.x = …) still
 *  changes what the code reads. */
export function platformDouble<T extends object>(parts: T): T & Platform {
  const out = parts as Record<string, unknown>;
  for (const [name, members] of Object.entries(DEFAULTS)) {
    const own = out[name] as Record<string, unknown> | undefined;
    if (!own) out[name] = { ...members };
    else for (const [key, value] of Object.entries(members)) if (!(key in own)) own[key] = value;
  }
  // A test that stands in a single lookup gets the batched one from it: an
  // entries list that moved from lookup per record to lookupMany (#9021)
  // threw inside every test that faked only lookup. Read at call time, so a
  // test that swaps its lookup later is still the one asked.
  const entities = out.entities as Record<string, unknown> | undefined;
  if (entities && typeof entities.lookup === "function" && !("lookupMany" in entities)) {
    entities.lookupMany = async (orgId: string, refs: ReadonlyArray<{ kind: string; id: string }>, viewer?: unknown) => {
      const lookup = entities.lookup as (o: string, k: string, i: string, v?: unknown) => Promise<Record<string, unknown> | null>;
      const found = await Promise.all(refs.map(async (r) => {
        const e = await lookup(orgId, r.kind, r.id, viewer);
        return e ? { ...e, kind: (e.kind as string | undefined) ?? r.kind, id: (e.id as string | undefined) ?? r.id } : null;
      }));
      return found.filter((e) => e !== null);
    };
  }
  // A test that stands in log gets the change-with-its-line from it: a route
  // that moved onto activity.transaction (#9035) logs through the test's own
  // log, after the change, as the kernel does once it commits. A fake
  // database with no transactions runs the change on itself.
  const activity = out.activity as Record<string, unknown> | undefined;
  if (activity && typeof activity.log === "function" && !("transaction" in activity)) {
    activity.transaction = async (_orgId: string, db: { transaction?: () => { execute: (fn: (trx: unknown) => Promise<unknown>) => Promise<unknown> } }, work: (trx: unknown, log: (p: unknown) => Promise<void>) => Promise<unknown>) => {
      const later: unknown[] = [];
      const run = (trx: unknown) => work(trx, async (p) => void later.push(p));
      const result = typeof db?.transaction === "function" ? await db.transaction().execute(run) : await run(db);
      for (const p of later) await (activity.log as (p: unknown) => Promise<void>)(p);
      return result;
    };
  }
  return parts as T & Platform;
}
