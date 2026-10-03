import { sql } from "kysely";
import { arrivedEverywhere, daysUntilField, platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";

export const WARRANTY_PASS = "platform.warranty-reminders";

export function registerWarrantyReminders(): void {
  platform().sweeps.register({
    name: WARRANTY_PASS,
    everyMs: 60 * 60 * 1000,
    candidates: async (ids) => (await meta.selectFrom("orgs").select("id")
      .where("id", "in", ids).where("warranty_reminders", "=", true).execute()).map((r) => r.id),
    visit: ({ orgId, now }) => remindWarranties(orgId, now),
  });
}

export async function remindWarranties(orgId: string, now: Date): Promise<{ notified: number }> {
  const settings = await meta.selectFrom("orgs").select("warranty_reminders").where("id", "=", orgId).executeTakeFirst();
  if (!settings?.warranty_reminders) return { notified: 0 };
  const today = arrivedEverywhere(now);
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 30);
  const events = (await platform().calendar.collect(orgId, today, end.toISOString().slice(0, 10)))
    .filter((e) => e.source === "warranty");
  if (!events.length) return { notified: 0 };
  const sent = await sql<{ event_id: string; user_id: string }>`
    select event_id, user_id from warranty_reminder_deliveries
    where org_id = ${orgId} and event_id in (${sql.join(events.map((e) => e.id))})
  `.execute(meta);
  const delivered = new Set(sent.rows.map((r) => `${r.user_id}:${r.event_id}`));
  let notified = 0;
  for (const userId of await platform().notifications.orgMemberIds(orgId)) {
    const due = events.filter((e) => !delivered.has(`${userId}:${e.id}`));
    if (!due.length) continue;
    const message = due.map((e) => `${e.title} in ${daysUntilField(e.date, today)} days (${e.date})`).join("\n");
    const only = due.length === 1 ? due[0] : undefined;
    const link = only?.entityModule && only.entityType && only.entityId
      ? await platform().entities.recordAddressForEntity(orgId, `${only.entityModule}:${only.entityType}`, only.entityId)
      : `/calendar?date=${due[0]!.date}`;
    // dispatch-per-row-ok: one combined reminder per member, remembering each recipient separately
    const result = await platform().notifications.dispatch({
      orgId, userId, eventType: "warranty.ending", triggeredBy: "schedule", priority: "normal",
      message, link_url: link ?? `/calendar?date=${due[0]!.date}`,
      entityType: only?.entityType, entityId: only?.entityId,
      payload: { count: due.length, expiresOn: only?.date },
    });
    if (!result.notificationId) continue;
    await sql`insert into warranty_reminder_deliveries (org_id, event_id, user_id)
      values ${sql.join(due.map((e) => sql`(${orgId}, ${e.id}, ${userId})`))}
      on conflict do nothing`.execute(meta);
    notified += due.length;
  }
  return { notified };
}
