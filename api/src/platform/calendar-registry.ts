// In-process registry of calendar event sources. Modules register at boot
// via platform().calendar.registerSource(id, fn); core-calendar (the in-app
// month view + the iCal feed) calls collect() to merge every source's
// events for a date window.
//
// Sources are best-effort: one that throws contributes nothing rather than
// failing the whole calendar — a calendar with most of your events beats no
// calendar at all.

import { PLATFORM_OWNER, type CalendarEvent, type CalendarSource, type CalendarSourceOwner } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { enabledOwnersWithParts, partOwner } from "./module-parts.js";

const sources = new Map<string, { source: CalendarSource; owner: CalendarSourceOwner }>();

export function registerSource(id: string, source: CalendarSource, owner: CalendarSourceOwner): void {
  sources.set(id, { source, owner });
}

const ownerKey = (o: CalendarSourceOwner) => (o.part ? partOwner(o.module, o.part) : o.module);

/** What of the workspace is on: the kernel, every module it has turned on, and
 *  `<module>/<part>` for each part that is on. The same rule the action doors
 *  read (actions.ts enabledActionOwners). */
async function enabledOwners(orgId: string): Promise<Set<string>> {
  const rows = await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute();
  return enabledOwnersWithParts(orgId, new Set([PLATFORM_OWNER, ...rows.map((r) => r.module_name)]));
}

/** Whether a module's records may reach the calendar, or a reminder, in this
 *  workspace: it is turned on here. A module that is off keeps its records
 *  and shows none of their dates. */
export async function moduleIsOn(orgId: string, module: string): Promise<boolean> {
  return (await enabledOwners(orgId)).has(module);
}

export async function collect(
  orgId: string,
  fromISO: string,
  toISO: string,
): Promise<CalendarEvent[]> {
  const on = await enabledOwners(orgId);
  const results = await Promise.all(
    [...sources.entries()].filter(([, s]) => on.has(ownerKey(s.owner))).map(async ([id, { source }]) => {
      try {
        return await source(orgId, fromISO, toISO);
      } catch (err) {
        console.error(`[calendar] source '${id}' failed:`, (err as Error).message);
        return [] as CalendarEvent[];
      }
    }),
  );
  const events = results.flat();
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return events;
}
