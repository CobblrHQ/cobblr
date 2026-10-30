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
 *  A namespace the test gives keeps the stand-ins it did not name. */
export function platformDouble(parts: Record<string, unknown>): Platform {
  const out: Record<string, unknown> = { ...parts };
  for (const [name, members] of Object.entries(DEFAULTS)) {
    out[name] = { ...members, ...((parts[name] as object | undefined) ?? {}) };
  }
  return out as unknown as Platform;
}
