// Calendar source: inventory parts with an `expires_on` date (the food
// cluster's expiry field, stored in inventory metadata) become all-day
// events — "milk expires", "leftovers go bad". The expiry concept is owned by
// lists; the data rides on inventory parts. lists doesn't read inventory's table
// directly — it asks the kernel for `inventory:part` rows whose `expires_on`
// falls in the window via platform().calendar.queryDateField, which resolves
// inventory's table from inventory's own registration and no-ops when inventory
// isn't enabled. (Audit burn-down — was a raw `from inventory_parts` read.)

import { platform } from "@cobblr/platform-contract";
import type { CalendarEvent } from "@cobblr/platform-contract";

const EXPIRY_KIND = "inventory:part";

export function registerExpiryCalendarSource(): void {
  platform().calendar.registerSource("expiry", async (orgId, fromISO, toISO) => {
    const rows = await platform().calendar.queryDateField(
      orgId,
      EXPIRY_KIND,
      "expires_on",
      fromISO,
      toISO,
    );
    const [entityModule, entityType] = EXPIRY_KIND.split(":");
    return rows.map<CalendarEvent>((r) => ({
      id: `expiry:${r.id}:${r.value}`,
      title: `${r.name} expires`,
      date: r.value.slice(0, 10),
      allDay: true,
      source: "expiry",
      category: "expiry",
      entityModule: entityModule!,
      entityType: entityType!,
      entityId: r.id,
    }));
  });
}
