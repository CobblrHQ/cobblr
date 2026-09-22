// The day it is where a person is, for code that has their id and nothing else.
//
// The rule is the platform's (`@cobblr/platform-contract/day`); this is the
// one thing the api can add to it: WHERE a person is. The only place anybody
// has told us is the IANA zone on their notification delivery window, set from
// their communication preferences, so that is what this reads. Somebody who
// has never opened that page has told us nothing, and the answer is then the
// day that has arrived everywhere: late for somebody rather than early for
// anybody (#3351).
//
// Cached for a minute per person: a filing door asks once per record, and a
// zone does not change between two of them. A miss is one small meta read.
import { arrivedEverywhere, dayIn, type Day } from "@cobblr/platform-contract/day";
import { meta } from "../db/meta.js";

const TTL_MS = 60_000;
const zones = new Map<string, { zone: string | null; at: number }>();

/** The zone this person said they are in, or null when they never said. */
export async function timeZoneOf(userId: string, now: Date = new Date()): Promise<string | null> {
  const hit = zones.get(userId);
  if (hit && now.getTime() - hit.at < TTL_MS) return hit.zone;
  let zone: string | null = null;
  try {
    const row = await meta
      .selectFrom("notification_delivery_windows")
      .select("timezone")
      .where("user_id", "=", userId)
      .orderBy("updated_at", "desc")
      .executeTakeFirst();
    zone = row?.timezone ?? null;
  } catch {
    // A meta read that failed is not a zone, and not a reason to refuse the
    // caller a day: it falls back like anybody who never said.
    zone = null;
  }
  zones.set(userId, { zone, at: now.getTime() });
  return zone;
}

/** The day it is for this person. `said` (a day their client sent) wins. */
export async function dayForPerson(userId: string | null | undefined, opts: { said?: unknown; now?: Date } = {}): Promise<Day> {
  const now = opts.now ?? new Date();
  if (typeof opts.said === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.said)) return opts.said;
  if (!userId) return arrivedEverywhere(now);
  return dayIn(now, await timeZoneOf(userId, now));
}

/** Tests and the preferences door: forget what we cached about this person. */
export function forgetTimeZone(userId?: string): void {
  if (userId) zones.delete(userId);
  else zones.clear();
}
