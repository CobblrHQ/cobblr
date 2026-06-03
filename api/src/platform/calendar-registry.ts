// In-process registry of calendar event sources. Modules register at boot
// via platform().calendar.registerSource(id, fn); core-calendar (the in-app
// month view + the iCal feed) calls collect() to merge every source's
// events for a date window.
//
// Sources are best-effort: one that throws contributes nothing rather than
// failing the whole calendar — a calendar with most of your events beats no
// calendar at all.

import type { CalendarEvent, CalendarSource } from "@cobblr/platform-contract";

const sources = new Map<string, CalendarSource>();

export function registerSource(id: string, source: CalendarSource): void {
  sources.set(id, source);
}

export function listSources(): string[] {
  return [...sources.keys()];
}

export async function collect(
  orgId: string,
  fromISO: string,
  toISO: string,
): Promise<CalendarEvent[]> {
  const results = await Promise.all(
    [...sources.entries()].map(async ([id, source]) => {
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
