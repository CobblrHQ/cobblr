// "Message someone" (#6070): an automation tells a person something, most
// often that a thing ran out and needs buying. A member is told through
// their own notification channels, as they set them up for "A message from
// an automation", so nothing new is needed and nothing reaches them that
// they did not choose. The words may use the record's fields; the wire
// engine fills them before the handler runs.
//
// Someone on the People list who is not a member (a partner, a shop) is
// reached only through the workspace's own email or SMS sender, which is a
// later part of #6070; until then the action says so instead of sending.

import { platform, type ActionInvokeContext } from "@cobblr/platform-contract";

export const MESSAGE_EVENT = "core-notifications.message";

/** The words when the wire gives none. */
export function defaultMessage(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n ? `${n} is used up. Could you get more?` : "Something is used up. Could you get more?";
}

/** Called once when the module's api loads. */
export function registerMessageSomeone(): void {
  platform().actions.registerHandler("core-notifications.message-someone", async (ctx) => messageSomeone(ctx, ctx.entity ?? null));
}

async function messageSomeone(ctx: ActionInvokeContext, entity: ActionInvokeContext["entity"] | null): Promise<unknown> {
  const args = ctx.args ?? {};
  const to = typeof args.to === "string" ? args.to.trim() : "";
  if (!to) return { ok: false, error: "who should get the message? pick a person" };
  const record = entity ? await platform().entities.lookup(ctx.orgId, entity.kind, entity.id).catch(() => null) : null;
  const said = typeof args.message === "string" && args.message.trim() ? args.message.trim() : defaultMessage(record?.title);
  const userId = await platform().accounts.userForPerson(ctx.orgId, to);
  if (!userId) {
    return {
      ok: false,
      error: "that person is not a member of this workspace; a message to someone outside it needs the workspace's own email or text sender",
    };
  }
  const name = (await platform().accounts.displayNames(ctx.orgId, [userId]))[userId] ?? "them";
  await platform().notifications.dispatch({
    orgId: ctx.orgId,
    userId,
    eventType: MESSAGE_EVENT,
    message: said.slice(0, 500),
    module: "core-notifications",
    ...(entity ? { entityType: entity.kind, entityId: entity.id } : {}),
    ...(record?.detailUrl ? { link_url: record.detailUrl } : { no_link_reason: "a message about no record, or one that is gone" }),
  });
  return { ok: true, summary: `Told ${name}: ${said.slice(0, 120)}`, activity_label: "Messaged someone" };
}
