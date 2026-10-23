// A maintenance reminder asks one question of an entry: was it done? Whether
// it has been answered is the entry's to say, read when the inbox is read: a
// reload, the bell in another tab and the Maintenance page all agree, and a
// Renewed that went through is not offered again to fail with a 409 (#7851).

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreMaintenanceDB } from "./db.js";

interface EntryState {
  performed_at: Date | null;
  nag_stopped_at: Date | null;
  nag_snoozed_until: Date | null;
}

/** How the entry answered the reminder, or null while it is still open. */
export function answerOf(entry: EntryState | undefined, now: Date): { label: string; at: string | null } | null {
  if (!entry) return { label: "No longer scheduled", at: null };
  if (entry.performed_at) return { label: "Done", at: new Date(entry.performed_at).toISOString() };
  if (entry.nag_stopped_at) return { label: "Reminders stopped", at: new Date(entry.nag_stopped_at).toISOString() };
  if (entry.nag_snoozed_until && new Date(entry.nag_snoozed_until).getTime() > now.getTime()) {
    return { label: `Snoozed until ${new Date(entry.nag_snoozed_until).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}`, at: null };
  }
  return null;
}

export function registerAnsweredReminders(): void {
  platform().notifications.registerActionSettlement(["core-maintenance:complete", "core-maintenance:reminders"], async (orgId, args) => {
    const ids = [...new Set(args.map((a) => (typeof a.entry_id === "string" ? a.entry_id : "")).filter(Boolean))];
    if (ids.length === 0) return args.map(() => null);
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreMaintenanceDB>;
    const rows = await db
      .selectFrom("core_maintenance_entries")
      .select(["id", "performed_at", "nag_stopped_at", "nag_snoozed_until"])
      .where("id", "in", ids)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const now = new Date();
    return args.map((a) => (typeof a.entry_id === "string" && a.entry_id ? answerOf(byId.get(a.entry_id), now) : null));
  });
}
