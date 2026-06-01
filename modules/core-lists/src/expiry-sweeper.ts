// Expiry sweeper — once an hour, scan every food-cluster workspace's inventory
// for parts whose `expires_on` (a custom field the food-cluster bundle adds,
// stored in inventory's metadata jsonb) falls within EXPIRY_SOON_DAYS. For each
// fresh match we:
//   1. Emit core-lists.item.expiring (so the food-cluster wire can auto-add it
//      to the shopping list via core-lists:add-item — same mechanism as low-stock).
//   2. Dispatch an in-app notification to every workspace member.
//   3. Record (part_id, expires_on) in core_lists_expiry_notifications so we
//      don't re-alert until the date changes (re-dated leftovers re-alert).
//
// Modelled on core-maintenance's sweeper. Only sweeps orgs that have BOTH
// core-lists and inventory enabled — others have no table / no expiry field and
// are skipped, so non-food workspaces pay nothing.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60 * 60 * 1000; // 1 hour
const EXPIRY_SOON_DAYS = 5;

export function startExpirySweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 35_000); // first pass after boot settles
  console.log(`[core-lists] expiry sweeper started — every ${TICK_MS / 60_000} min, threshold ${EXPIRY_SOON_DAYS}d`);
}

export function stopExpirySweeper(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[core-lists] expiry sweeper stopped");
  }
}

async function safeTick(): Promise<void> {
  try {
    await expiryTick();
  } catch (err) {
    console.error("[core-lists] expiry sweep failed:", (err as Error).stack ?? (err as Error).message);
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
  // Need BOTH inventory (the parts + expires_on) and core-lists (the ledger + list).
  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m_lists", (j) => j.onRef("m_lists.org_id", "=", "orgs.id").on("m_lists.module_name", "=", "core-lists"))
    .innerJoin("org_modules as m_inv", (j) => j.onRef("m_inv.org_id", "=", "orgs.id").on("m_inv.module_name", "=", "inventory"))
    .select(["orgs.id"]);
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);

  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch (err) {
    console.warn("[core-lists] expiry sweep skipped — meta read failed:", (err as Error).message);
    return { scanned: 0, alerted: 0 };
  }

  let scanned = 0;
  let alerted = 0;

  for (const org of orgs) {
    let tdb: Kysely<unknown>;
    try {
      tdb = (await platform().tenants.getDb(org.id)) as Kysely<unknown>;
    } catch {
      continue;
    }

    // Parts expiring soon that we haven't alerted for at THIS expires_on value.
    // The left join to our ledger lets a re-dated leftover re-alert.
    let due: ExpiringRow[];
    try {
      const compiled = sql<ExpiringRow>`
        select p.id::text as id, p.name as name, (p.metadata->>'expires_on') as expires_on
        from inventory_parts p
        left join core_lists_expiry_notifications n
          on n.part_id = p.id::text and n.expires_on = (p.metadata->>'expires_on')::date
        where p.metadata->>'expires_on' is not null
          and (p.metadata->>'expires_on')::date <= (current_date + ${EXPIRY_SOON_DAYS} * interval '1 day')
          and n.part_id is null
      `.compile(tdb);
      const result = (await tdb.executeQuery(compiled)) as { rows: ExpiringRow[] };
      due = result.rows;
    } catch (err) {
      const msg = (err as Error).message;
      // tenant may not have these tables/fields yet (migration mid-flight, or
      // food-cluster not installed so no expires_on ever set) → skip quietly.
      if (msg.includes("does not exist") || msg.includes("expires_on")) continue;
      throw err;
    }

    scanned += due.length;
    if (due.length === 0) continue;

    const memberIds = await platform().notifications.orgMemberIds(org.id);

    for (const row of due) {
      const daysUntil = Math.ceil((new Date(row.expires_on).getTime() - Date.now()) / 86_400_000);
      const tone = daysUntil < 0 ? `expired ${-daysUntil}d ago` : daysUntil === 0 ? "expires today" : `expires in ${daysUntil}d`;

      // Event → food-cluster wire turns this into a shopping-list line. The
      // wire engine resolves the source entity from a `<kindSuffix>Id` payload
      // key — for source_kind inventory:part that's `partId` (NOT entityId).
      void platform().events.emit("core-lists.item.expiring", {
        orgId: org.id,
        partId: row.id,
        name: row.name,
        expiresOn: row.expires_on,
        daysUntil,
      });

      for (const userId of memberIds) {
        try {
          await platform().notifications.dispatch({
            orgId: org.id,
            userId,
            eventType: "core-lists.expiring",
            message: `${row.name} — ${tone}`,
            module: "core-lists",
            entityType: "inventory:part",
            entityId: row.id,
            payload: { expiresOn: row.expires_on, daysUntil },
          });
        } catch (err) {
          console.error("[core-lists] expiry notify failed:", (err as Error).message);
        }
      }

      // Stamp the ledger (upsert: re-dated parts overwrite the prior alert).
      try {
        const up = sql`
          insert into core_lists_expiry_notifications (part_id, expires_on, notified_at)
          values (${row.id}, ${row.expires_on}::date, now())
          on conflict (part_id) do update set expires_on = excluded.expires_on, notified_at = now()
        `.compile(tdb);
        await tdb.executeQuery(up);
      } catch (err) {
        console.error("[core-lists] expiry ledger write failed:", (err as Error).message);
      }
      alerted += 1;
    }
  }

  if (alerted > 0) console.log(`[core-lists] expiry sweep: scanned ${scanned}, alerted ${alerted}`);
  return { scanned, alerted };
}
