// Live-box capability: `printer.connected`. A workspace with at least one
// configured printer makes label auto-print an applicable live control. Modules
// gate their exposes.live controls on this via `requires: "printer.connected"`.
// See docs/design-decisions/live-controls.md §3.2.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CorePrintDB } from "./db.js";

export function registerLiveCapabilities(): void {
  platform().live.registerCapability("printer.connected", async (orgId) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CorePrintDB>;
    const row = await db
      .selectFrom("core_print_printers")
      .select((eb) => eb.fn.countAll().as("n"))
      .executeTakeFirst();
    return Number(row?.n ?? 0) > 0;
  });
}
