// Telling a workspace when its bridge goes quiet, and when it is back.
//
// A bridge is a small box on somebody's shelf. When it stops (a power cut, a
// router reboot, a Pi that ran out of SD card) nothing in Cobblr said so: the
// next print or import failed with a line about a channel, and the bridges page
// only showed it offline to whoever happened to open it. The owners and admins
// now hear once, ten minutes in, naming the bridge the way they named it, and
// once more when it comes back.
//
// Once per outage, across every api process: the notice is CLAIMED by the
// UPDATE that stamps `offline_noticed_at` on rows where it is still null, and
// Postgres re-checks that condition after the row lock, so a second process
// running the same round claims nothing. Coming back clears the stamp by the
// same kind of claim.
//
// Only outages that begin while this runs are announced: a bridge unheard-from
// for more than a day when the watch first sees it is an abandoned install, not
// news, and telling everyone about every one of those on the first deploy would
// teach them to ignore the notice.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { dispatch } from "./notifications.js";
import { howLongAgo } from "./edge.js";
import { bridgeDisplayName } from "@cobblr/platform-contract/edge-channel";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

export const OFFLINE_NOTICE_AFTER_MS = 10 * 60_000;
const ABANDONED_AFTER_MS = 24 * 60 * 60_000;
const WATCH_EVERY_MS = 60_000;

/** The kinds this sends, as the notification-audience settings list them: a
 *  kernel sender has no module manifest to declare them in. */
export const BRIDGE_NOTIFICATION_KINDS = [
  {
    eventType: "edge.bridge.offline",
    label: "A bridge went offline",
    description: "Ten minutes after a bridge stops answering. Sent to owners and admins.",
  },
  { eventType: "edge.bridge.online", label: "A bridge is back online", description: "After an offline notice, when it answers again." },
] as const;

export interface BridgeOutageNotice {
  orgId: string;
  bridge: string | null;
  name: string;
  state: "offline" | "online";
  lastSeen: Date;
}

/** Split a channel key into its workspace and bridge. Null for a personal
 *  bridge, whose key is a user id; the caller confirms the workspace exists. */
function splitKey(key: string): { orgId: string; bridge: string | null } {
  const i = key.indexOf("::");
  return i < 0 ? { orgId: key, bridge: null } : { orgId: key.slice(0, i), bridge: key.slice(i + 2) };
}

export function outageMessage(n: BridgeOutageNotice, now: Date): string {
  return n.state === "offline"
    ? `Your bridge “${n.name}” stopped answering ${howLongAgo(n.lastSeen, now)} ago. Printers, imports and anything else that goes through it will wait until it is back. Check that the box it runs on has power and a network connection.`
    : `Your bridge “${n.name}” is back online.`;
}

/** One round: claim every outage that crossed the line and every return, and
 *  hand each to `tell`. Returns what was told, for a test to read. */
export async function noticeBridgeOutages(
  now: Date = new Date(),
  tell: (n: BridgeOutageNotice) => Promise<void> = tellOwners,
  /** Only channel keys LIKE this. A caller that does not deliver what it
   *  claims (a test) must scope itself, or it swallows real notices. */
  keyLike?: string,
): Promise<BridgeOutageNotice[]> {
  const quietSince = new Date(now.getTime() - OFFLINE_NOTICE_AFTER_MS);
  const abandonedBefore = new Date(now.getTime() - ABANDONED_AFTER_MS);

  const wentQuiet = await meta
    .updateTable("edge_bridges")
    .set({ offline_noticed_at: now })
    .where("offline_noticed_at", "is", null)
    .where("last_seen", "<", quietSince)
    .where("last_seen", ">", abandonedBefore)
    // A personal bridge (keyed by a user id) serves one person's own AI and
    // sleeps with their laptop; only workspace bridges are announced.
    .where(sql<boolean>`split_part(channel_key, '::', 1) in (select id::text from orgs)`)
    .$if(!!keyLike, (q) => q.where("channel_key", "like", keyLike!))
    .returning(["channel_key", "name", "last_seen"])
    .execute();

  const cameBack = await meta
    .updateTable("edge_bridges")
    .set({ offline_noticed_at: null })
    .where("offline_noticed_at", "is not", null)
    .where((eb) => eb("last_seen", ">", eb.ref("offline_noticed_at")))
    .$if(!!keyLike, (q) => q.where("channel_key", "like", keyLike!))
    .returning(["channel_key", "name", "last_seen"])
    .execute();

  const told: BridgeOutageNotice[] = [];
  for (const [rows, state] of [
    [wentQuiet, "offline"],
    [cameBack, "online"],
  ] as const) {
    for (const r of rows) {
      const { orgId, bridge } = splitKey(r.channel_key);
      const n: BridgeOutageNotice = {
        orgId,
        bridge,
        name: bridgeDisplayName({ bridge, name: r.name }),
        state,
        lastSeen: new Date(r.last_seen),
      };
      try {
        await tell(n);
        told.push(n);
      } catch (err) {
        console.error(`[edge] could not tell org ${orgId} its bridge is ${state}:`, (err as Error)?.message ?? err);
      }
    }
  }
  return told;
}

/** The people who can do something about a bridge: the owners and admins. */
async function tellOwners(n: BridgeOutageNotice): Promise<void> {
  const people = (
    await meta.selectFrom("org_memberships").select(["user_id", "role"]).where("org_id", "=", n.orgId).execute()
  ).filter((m) => roleSatisfies(m.role, ["owner", "admin"]));
  const message = outageMessage(n, new Date());
  for (const p of people) {
    await dispatch({
      orgId: n.orgId,
      userId: String(p.user_id),
      eventType: BRIDGE_NOTIFICATION_KINDS[n.state === "offline" ? 0 : 1].eventType,
      message,
      // PAGE-LINK: the bridges page, where the bridge's status, host and last
      // contact are shown and it can be set up again.
      link_url: "/configuration/devices",
      priority: n.state === "offline" ? "high" : "normal",
      payload: { bridge: n.bridge, name: n.name, last_seen: n.lastSeen.toISOString() },
    });
  }
}

let watching: ReturnType<typeof setInterval> | null = null;

/** Start the once-a-minute watch. Idempotent. */
export function startBridgeOutageWatch(): void {
  if (watching) return;
  // SINGLE-PROCESS-SAFE: every notice is claimed by an UPDATE whose WHERE
  // Postgres re-checks under the row lock, so two processes running the same
  // round never both send one.
  watching = setInterval(() => {
    void noticeBridgeOutages().catch((err) =>
      console.error("[edge] bridge outage watch failed:", (err as Error)?.message ?? err),
    );
  }, WATCH_EVERY_MS);
  watching.unref?.();
}
