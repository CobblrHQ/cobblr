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

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60 * 60 * 1000; // 1 hour
const EXPIRY_SOON_DAYS = 5;

export function startExpirySweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 35_000); // first pass after boot settles
  console.log(`[lists] expiry sweeper started — every ${TICK_MS / 60_000} min, threshold ${EXPIRY_SOON_DAYS}d`);
}

export function stopExpirySweeper(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[lists] expiry sweeper stopped");
  }
}

async function safeTick(): Promise<void> {
  try {
      // One process only: every api runs this loop, and more than one api
      // runs against a single database (the canary channel; a rolling deploy).
      // Unguarded, each tick's notifications and writes happen twice.
    await platform().exclusive.run("lists.expiry-sweep", async () => {
      await expiryTick();
    });
  } catch (err) {
    console.error("[lists] expiry sweep failed:", (err as Error).stack ?? (err as Error).message);
  }
}

interface ExpiringRow {
  id: string;
  name: string;
  expires_on: string; // 'YYYY-MM-DD'
}

/** One sweep. Exported so tests/CLI can fire it deterministically. */
export async function expiryTick(opts: { orgId?: string } = {}): Promise<{ scanned: number; alerted: number }> {
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;
  // Orgs with lists enabled (lists owns the ledger + the shopping list). We
  // DON'T also join on inventory: the kernel date-field query no-ops for an org
  // without inventory or without any expires_on, so lists needn't name another
  // module here. (Audit burn-down — was an `org_modules ... "inventory"` join.)
  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m_lists", (j) => j.onRef("m_lists.org_id", "=", "orgs.id").on("m_lists.module_name", "=", "lists"))
    .select(["orgs.id"]);
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);

  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch (err) {
    console.warn("[lists] expiry sweep skipped — meta read failed:", (err as Error).message);
    return { scanned: 0, alerted: 0 };
  }

  let scanned = 0;
  let alerted = 0;

  for (const org of orgs) {
    try {
      // withDb releases the org's pool the moment this closure returns —
      // a getDb + releaseIdleDb pair can't release its own pool inside the
      // grace window, which held one pool per tenant and exhausted Postgres.
      await platform().tenants.withDb(org.id, async (raw) => {
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
    const memberIds = await platform().notifications.orgMemberIds(org.id);

    for (const row of dueToday) {
      for (const userId of memberIds) {
        try {
          await platform().notifications.dispatch({
            orgId: org.id,
            userId,
            eventType: "lists.expiring_today",
            triggeredBy: "schedule",
            message: `${row.name}: expires today`,
            module: "lists",
            entityType: "inventory:part",
            entityId: row.id,
            payload: { expiresOn: row.expires_on, daysUntil: 0 },
          });
        } catch (err) {
          console.error("[lists] expiry day-of notify failed:", (err as Error).message);
        }
      }
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

      for (const userId of memberIds) {
        try {
          await platform().notifications.dispatch({
            orgId: org.id,
            userId,
            eventType: "lists.expiring",
            // A date arrived. Better as one line in somebody's morning list
            // than as an interruption at whatever hour the sweep ran.
            triggeredBy: "schedule",
            message: `${row.name} — ${tone}`,
            module: "lists",
            entityType: "inventory:part",
            entityId: row.id,
            payload: { expiresOn: row.expires_on, daysUntil },
          });
        } catch (err) {
          console.error("[lists] expiry notify failed:", (err as Error).message);
        }
      }

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
      });
    } catch (err) {
      // Per-org isolation: one gone/unprovisioned tenant must not abort the
      // sweep for everyone else (CLAUDE.md §8.1).
      console.warn(`[lists] expiry sweep skipped org ${org.id}:`, (err as Error).message);
    }
  }

  if (alerted > 0) console.log(`[lists] expiry sweep: scanned ${scanned}, alerted ${alerted}`);
  return { scanned, alerted };
}
