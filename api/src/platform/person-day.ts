// The day it is where a person is, for code that has their id and nothing else.
//
// The rule is the platform's (`@cobblr/platform-contract/day`); this is the
// one thing the api can add to it: WHERE a person is. First the zone their own
// browser reported (users.time_zone, sent by the app they use); then the IANA
// zone on a notification delivery window, from their communication
// preferences. Somebody who has told us neither gets the day that has arrived
// everywhere: late for somebody rather than early for anybody (#3351).
//
// Cached for a minute per person: a filing door asks once per record, and a
// zone does not change between two of them. A miss is one small meta read.
import { WORKSPACE_ZONE_UNSET, arrivedEverywhere, dayIn, type Day } from "@cobblr/platform-contract/day";
import { meta } from "../db/meta.js";
import { ttlCache } from "../lib/ttl-cache.js";

const TTL_MS = 60_000;
const zones = ttlCache<string | null>(TTL_MS);

/** The zone this person said they are in, or null when they never said. A
 *  filing door asks once per record, so the first asks share one read. */
export async function timeZoneOf(userId: string, _now: Date = new Date()): Promise<string | null> {
  return zones.get(userId, async () => {
    try {
      const own = await meta.selectFrom("users").select("time_zone").where("id", "=", userId).executeTakeFirst();
      if (own?.time_zone) return own.time_zone;
      const row = await meta
        .selectFrom("notification_delivery_windows")
        .select("timezone")
        .where("user_id", "=", userId)
        .orderBy("updated_at", "desc")
        .executeTakeFirst();
      return row?.timezone ?? null;
    } catch {
      // A meta read that failed is not a zone, and not a reason to refuse the
      // caller a day: it falls back like anybody who never said.
      return null;
    }
  });
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

/** A workspace's calendar zone, or null while it is not known: no owner has
 *  reported one. Kept once learned, even when its owner travels. A reader with
 *  a zone of its own reads an unknown one in that zone, the way every date was
 *  read before workspaces had a zone (#8748). */
export async function workspaceZoneIfKnown(orgId: string): Promise<string | null> {
  const org = await meta.selectFrom("orgs").select("time_zone").where("id", "=", orgId).executeTakeFirst();
  if (org?.time_zone) return org.time_zone;
  const owners = await meta.selectFrom("org_memberships").select("user_id")
    .where("org_id", "=", orgId).where("role", "=", "owner")
    .orderBy("joined_at").orderBy("user_id").execute();
  for (const owner of owners) {
    const zone = await timeZoneOf(owner.user_id);
    if (!zone) continue;
    const saved = await meta.updateTable("orgs").set({ time_zone: zone })
      .where("id", "=", orgId).where("time_zone", "is", null).returning("time_zone").executeTakeFirst();
    if (saved?.time_zone) return saved.time_zone;
    const current = await meta.selectFrom("orgs").select("time_zone").where("id", "=", orgId).executeTakeFirst();
    if (current?.time_zone) return current.time_zone;
  }
  return null;
}

/** The workspace's calendar zone, UTC while it is not known. */
export async function workspaceTimeZone(orgId: string): Promise<string> {
  return (await workspaceZoneIfKnown(orgId)) ?? WORKSPACE_ZONE_UNSET;
}
