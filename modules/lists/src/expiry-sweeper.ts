// Expiry sweeper — once an hour, scan every food-cluster workspace's inventory
// for parts whose `expires_on` (a custom field the food-cluster bundle adds,
// stored in inventory's metadata jsonb) falls within EXPIRY_SOON_DAYS. For each
// fresh match we:
//   1. Emit lists.item.expiring (so the food-cluster wire can auto-add it
//      to the shopping list via lists:add-item — same mechanism as low-stock).
//   2. Dispatch an in-app notification to every workspace member.
//   3. Record (part_id, expires_on) in lists_expiry_notifications so we
//      don't re-alert until the date changes (re-dated leftovers re-alert).
//
// Modelled on core-maintenance's sweeper. Only sweeps orgs that have BOTH
// lists and inventory enabled — others have no table / no expiry field and
// are skipped, so non-food workspaces pay nothing.
//
// TWO RULES THE ORDER OF THIS FILE ENFORCES (#3349):
//   · Every line the sweep decides to say is sent. The day-of lines were
//     computed, stamped in the ledger and then dropped by an early return
//     that only knew about heads-ups, so from the day the day-of notice was
//     added, "expires today" reached a person only when a new heads-up
//     happened to ride along in the same sweep. The one dispatch is behind
//     `lines.length > 0` and nothing returns between the lines and it.
//   · The ledger is stamped AFTER the message is sent, never before. A stamp
//     first meant a dispatch that failed for every member was recorded as
//     sent and never retried; a duplicate on a failed stamp is the smaller
//     harm. Nobody to tell (an empty audience) is a send.
//   · The clock is the walk's (`now`), never Date.now(), so the day a thing
//     expires can be pressed in a test after its heads-up went out on an
//     earlier day.

import { Kysely, sql } from "kysely";
import { platform, expiryState, expiryPhrase, arrivedEverywhere, daysUntilField } from "@cobblr/platform-contract";
import { expiryStages } from "./expiry-stages.js";
import { expiryDigest, type ExpiryLine } from "./expiry-card.js";

const TICK_MS = 60 * 60 * 1000; // 1 hour
export const EXPIRY_PASS = "lists.expiry-sweep";
const EXPIRY_SOON_DAYS = 5;

export function startExpirySweeper(): void {
  // The walk is the kernel's (platform().sweeps, #3036): this registers the
  // per-workspace visit and its cadence and owns no timer, so the pass shares
  // one walk and one connection budget with every other pass.
  platform().sweeps.register({
    name: EXPIRY_PASS,
    everyMs: TICK_MS,
    module: "lists",
    visit: ({ orgId, db, now }) => visitWorkspace(orgId, db, now),
  });
  console.log(`[lists] expiry sweeper registered — every ${TICK_MS / 60_000} min, threshold ${EXPIRY_SOON_DAYS}d`);
}

/** Nothing to stop: the kernel's walk owns the timer. Kept for the module's shutdown hook. */
export function stopExpirySweeper(): void {}

interface ExpiringRow {
  id: string;
  name: string;
  expires_on: string; // 'YYYY-MM-DD'
}

/** One workspace, the pool already open: the pass's visit. `org` and `raw`
 *  keep their names so the body reads as it did when it was the loop's.
 *  Exported for its tests, which hand it a fake db and a fixed clock. */
export async function visitWorkspace(orgId: string, raw: unknown, now: Date = new Date()): Promise<{ scanned: number; alerted: number; unreadable: number; undelivered?: number } | void> {
  const org = { id: orgId };
  let scanned = 0;
  let alerted = 0;
    const tdb = raw as Kysely<unknown>;
    // Parts expiring within the window, via the kernel date-field query — no raw
    // inventory_parts read, no inventory table name here. queryDateField no-ops
    // (returns []) when inventory/expires_on is absent.
    // The window and the day below are the day that has ARRIVED EVERYWHERE,
    // not the UTC day: this digest is decided once for a workspace and sent to
    // every member, so there is no single clock to read, and the UTC day says
    // "expires today" through the whole evening before it, for anybody west of
    // Greenwich (#3351). Late for somebody beats early for anybody, the same
    // rule the arrival sweeper uses.
    const toISO = arrivedEverywhere(new Date(now.getTime() + EXPIRY_SOON_DAYS * 86_400_000));
    const candidates = await platform().calendar.queryDateField(
      org.id,
      "inventory:part",
      "expires_on",
      "1970-01-01", // no lower bound — include already-expired leftovers
      toISO,
    );
    // A dated row whose value names no day is not a candidate and never
    // blanks the others; it is counted here and named on the dashboard's
    // attention list, so "nothing due" and "something could not be read"
    // are two different answers. One such value once read as the first for
    // a whole workspace, twelve days running (#3279).
    const unreadable = await platform().calendar.unreadableDateField(org.id, "inventory:part", "expires_on");
    if (unreadable.length > 0) {
      const eg = unreadable[0]!;
      console.warn(`[lists] expiry sweep: ${unreadable.length} expiry date(s) in workspace ${org.id} cannot be read (e.g. "${eg.name}": "${eg.value}"); they are on the attention list`);
    }

    // Drop any we've already alerted at THIS expires_on (our own ledger); a
    // re-dated leftover (different expires_on) re-alerts. Was a SQL left join to
    // inventory_parts — now a JS filter against lists' own table.
    let due: ExpiringRow[] = [];
    let dueToday: ExpiringRow[] = [];
    if (candidates.length > 0) {
      const alreadyAtDate = new Map<string, string>();
      const todayDoneAt = new Map<string, string>();
      try {
        const led = sql<{ part_id: string; expires_on: string; today_notified_on: string | null }>`
          select part_id::text as part_id, expires_on::text as expires_on, today_notified_on::text as today_notified_on
          from lists_expiry_notifications
          where part_id = any(${candidates.map((c) => c.id)})
        `.compile(tdb);
        const r = (await tdb.executeQuery(led)) as {
          rows: { part_id: string; expires_on: string; today_notified_on: string | null }[];
        };
        for (const x of r.rows) {
          alreadyAtDate.set(x.part_id, x.expires_on.slice(0, 10));
          if (x.today_notified_on) todayDoneAt.set(x.part_id, x.today_notified_on.slice(0, 10));
        }
      } catch (err) {
        // The ledger is what stops the digest going out every hour. Without
        // it (lists enabled, its migration not landed) every candidate is due
        // every sweep and every write fails quietly: the digest as a stream.
        // A stream trains a person to mute the channel; a skip is visible.
        // Thrown, so the walk counts this workspace as failed and /healthz
        // names the pass, and the pending migration is already on /healthz.
        if ((err as Error).message.includes("does not exist")) {
          throw new Error("lists_expiry_notifications is missing (lists' migration has not run here); not sending expiry reminders until it lands");
        }
        throw err;
      }
      const todayISO = arrivedEverywhere(now);
      due = candidates
        .filter((c) => alreadyAtDate.get(c.id) !== c.value.slice(0, 10))
        .map((c) => ({ id: c.id, name: c.name, expires_on: c.value }));
      // The DAY-OF notice, for dates the heads-up already covered: each date
      // earns exactly two lines in somebody's morning list, heads-up and today
      // (expiry-stages.ts holds the rule). Sent here so it never waits on the
      // heads-up path, which skips a date it has already announced.
      dueToday = candidates
        .filter((c) => {
          const stages = expiryStages({
            expiresOn: c.value.slice(0, 10),
            today: todayISO,
            headsUpSentFor: alreadyAtDate.get(c.id) ?? null,
            todaySentFor: todayDoneAt.get(c.id) ?? null,
          });
          return stages.today && !stages.headsUp;
        })
        .map((c) => ({ id: c.id, name: c.name, expires_on: c.value }));
    }
    if (due.length === 0 && dueToday.length === 0) return { scanned, alerted, unreadable: unreadable.length };
    // The people this KIND is for in this workspace (everyone by default;
    // the owners, or a chosen few, once somebody says so under Configuration).
    const memberIds = await platform().notifications.audienceFor(org.id, "lists.expiring");
    // ONE MESSAGE PER SWEEP, not one per row. This dispatched inside the row
    // loop, so a fridge with six dated things sent six DMs in a row:
    //
    //   Croissant — expired 12d ago
    //   Roma Tomatoes — expired 10d ago
    //   Cucumbers Long — expired 3d ago
    //   ...
    //
    // The delivery-window digest would have combined them, but only for a
    // person who has configured a window - so the DEFAULT experience of a
    // stocked fridge was a stream. A sweep already holds every row it is about;
    // composing one message is not a preference, it is what a batch job owes
    // the person it is writing to.
    const lines: ExpiryLine[] = [];
    for (const row of dueToday) lines.push({ id: row.id, name: row.name, tone: "expires today" });

    scanned += due.length;
    // What each heads-up row says, and the events a wire hears. Nothing is
    // written yet: the ledger is stamped once the message has gone.
    const headsUp: Array<{ row: ExpiringRow; dayOfCovered: boolean }> = [];
    for (const row of due) {
      const daysUntil = daysUntilField(row.expires_on, arrivedEverywhere(now)) ?? 0;
      // The item's own grace: food does not go bad at midnight, and the item
      // says how long past its date is still fine. Read through the entities
      // door so an instance row (a Groceries table's milk) answers too - the
      // sweep's candidate set is small, so one lookup per due row is cheap.
      let graceDays: unknown = 0;
      if (daysUntil < 0) {
        try {
          const ent = await platform().entities.lookup(org.id, "inventory:part", row.id);
          graceDays = ent?.fields?.grace_days;
        } catch {
          // Unreadable grace reads as none - the pre-grace behaviour, never a
          // silently-extended one.
        }
      }
      // Read against the DAY this sweep is claiming, not the instant: a
      // reading taken at 02:00 UTC called a date twelve hours away "expires
      // today", which is the same lie the window used to tell (#3351).
      const reading = expiryState(row.expires_on, graceDays, arrivedEverywhere(now));
      const tone = reading ? expiryPhrase(reading) : `expires in ${daysUntil}d`;

      // Event → food-cluster wire turns this into a shopping-list line. The
      // wire engine resolves the source entity from a `<kindSuffix>Id` payload
      // key — for source_kind inventory:part that's `partId` (NOT entityId).
      //
      // TWO events, because one covered two different facts and a wire could
      // not tell them apart. `expiring` fires from EXPIRY_SOON_DAYS out, which
      // means an item whose whole shelf life is shorter than that window is
      // "expiring" the moment it is entered. Anything hung off it therefore
      // fires for food that is perfectly good — a Groceries wire recorded a
      // ledger `discard` on it, so six meal containers with a five-day life
      // were written off as waste within the hour of arriving.
      //
      // `expired` is the narrower fact: the date has actually passed. Note that
      // it still is not "was thrown away" — that needs a person to say so, and
      // the grace-period ask is what will collect it.
      const payload = {
        orgId: org.id,
        partId: row.id,
        name: row.name,
        expiresOn: row.expires_on,
        daysUntil,
      };
      void platform().events.emit("lists.item.expiring", payload);
      // `expired` waits out the grace. Within it the honest fact is "past its
      // date, still fine" - a wire that discards or re-buys on `expired` must
      // not fire while the item's own grace says the food is good. (This is
      // the grace-period ask the comment above anticipated.)
      if (reading?.state === "spoiled") void platform().events.emit("lists.item.expired", payload);

      lines.push({ id: row.id, name: row.name, tone });
      // A heads-up sent ON the day is the day-of notice too, so that date's
      // second line is spent as well; a re-dated part clears it.
      headsUp.push({ row, dayOfCovered: daysUntil <= 0 });
    }

    if (lines.length === 0) return { scanned, alerted, unreadable: unreadable.length };

    // The one message. A date arriving is a line in somebody's list, never an
    // interruption at whatever hour the sweep ran, so this stays at the default
    // priority and joins a configured delivery window like anything else.
    //
    // A CARD with the answers on it (expiry-card.ts): one line per item and
    // a "Used up" / "Threw out" pair each, running the inventory module's
    // own actions. The plain message still stands alone for a channel that
    // cannot render either.
    const digest = expiryDigest(lines, {
      workspace: await platform().notifications.orgName(org.id).catch(() => null),
    });
    // WHERE IT TAKES YOU. One item → the item, instance-aware (a jar in a
    // Groceries table is not on the base inventory page). Several → the
    // calendar on the earliest date, because "everything dated" is exactly
    // what that surface is. It used to carry no link, so a list of six things
    // going bad was six names and no way through to any of them.
    const all = [...dueToday, ...due];
    const earliest = all
      .map((r) => r.expires_on.slice(0, 10))
      .sort()[0];
    let link = `/calendar?date=${earliest}`;
    if (all.length === 1) {
      link =
        (await platform()
          .entities.detailPathForEntity(org.id, "inventory:part", all[0]!.id)
          .catch(() => undefined)) ?? link;
    }
    let delivered = 0;
    for (const userId of memberIds) {
      try {
        await platform().notifications.dispatch({
          orgId: org.id,
          userId,
          eventType: "lists.expiring",
          triggeredBy: "schedule",
          message: digest.message,
          card: digest.card,
          actions: digest.actions,
          link_url: link,
          module: "lists",
          payload: { count: lines.length },
        });
        delivered += 1;
      } catch (err) {
        console.error("[lists] expiry notify failed:", (err as Error).message);
      }
    }
    // Sent, or nobody to send to: the ledger remembers it. Reached nobody
    // while there was somebody to reach: the ledger stays as it was and the
    // next sweep says it again.
    if (delivered === 0 && memberIds.length > 0) {
      console.warn(`[lists] expiry digest for workspace ${org.id} reached none of ${memberIds.length} member(s); it will be sent again next sweep`);
      return { scanned, alerted, unreadable: unreadable.length, undelivered: lines.length };
    }
    for (const row of dueToday) {
      try {
        const up = sql`
          update lists_expiry_notifications set today_notified_on = ${row.expires_on}::date where part_id = ${row.id}
        `.compile(tdb);
        await tdb.executeQuery(up);
      } catch (err) {
        console.error("[lists] expiry day-of ledger write failed:", (err as Error).message);
      }
      alerted += 1;
    }
    for (const { row, dayOfCovered } of headsUp) {
      // Stamp the ledger (upsert: re-dated parts overwrite the prior alert).
      try {
        const up = sql`
          insert into lists_expiry_notifications (part_id, expires_on, notified_at, today_notified_on)
          values (${row.id}, ${row.expires_on}::date, now(), ${dayOfCovered ? row.expires_on : null}::date)
          on conflict (part_id) do update set expires_on = excluded.expires_on, notified_at = now(), today_notified_on = excluded.today_notified_on
        `.compile(tdb);
        await tdb.executeQuery(up);
      } catch (err) {
        console.error("[lists] expiry ledger write failed:", (err as Error).message);
      }
      alerted += 1;
    }
  return { scanned, alerted, unreadable: unreadable.length };
}
