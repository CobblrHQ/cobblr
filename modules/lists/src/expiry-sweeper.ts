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

import { Kysely, sql } from "kysely";
import { platform, expiryState, expiryPhrase } from "@cobblr/platform-contract";
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
    visit: ({ orgId, db }) => visitWorkspace(orgId, db),
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
 *  keep their names so the body reads as it did when it was the loop's. */
async function visitWorkspace(orgId: string, raw: unknown): Promise<{ scanned: number; alerted: number } | void> {
  const org = { id: orgId };
  let scanned = 0;
  let alerted = 0;
    const tdb = raw as Kysely<unknown>;
    // Parts expiring within the window, via the kernel date-field query — no raw
    // inventory_parts read, no inventory table name here. queryDateField no-ops
    // (returns []) when inventory/expires_on is absent.
    const toISO = new Date(Date.now() + EXPIRY_SOON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const candidates = await platform().calendar.queryDateField(
      org.id,
      "inventory:part",
      "expires_on",
      "1970-01-01", // no lower bound — include already-expired leftovers
      toISO,
    );

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
        if (!(err as Error).message.includes("does not exist")) throw err;
      }
      const todayISO = new Date().toISOString().slice(0, 10);
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
    if (due.length === 0 && dueToday.length === 0) return;
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
    for (const row of dueToday) {
      lines.push({ id: row.id, name: row.name, tone: "expires today" });
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

    scanned += due.length;
    if (due.length === 0) return;

    for (const row of due) {
      const daysUntil = Math.ceil((new Date(row.expires_on).getTime() - Date.now()) / 86_400_000);
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
      const reading = expiryState(row.expires_on, graceDays);
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

      // Stamp the ledger (upsert: re-dated parts overwrite the prior alert).
      // A heads-up sent ON the day is the day-of notice too, so that date's
      // second line is spent as well; a re-dated part clears it.
      const dayOfCovered = daysUntil <= 0;
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

    // The one message. A date arriving is a line in somebody's list, never an
    // interruption at whatever hour the sweep ran, so this stays at the default
    // priority and joins a configured delivery window like anything else.
    if (lines.length > 0) {
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
        } catch (err) {
          console.error("[lists] expiry notify failed:", (err as Error).message);
        }
      }
    }
  return { scanned, alerted };
}
