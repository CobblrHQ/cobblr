// "Message someone" (#6070): an automation tells a person something, most
// often that a thing ran out and needs buying. A member is told through
// their own notification channels, as they set them up for "A message from
// an automation", so nothing new is needed and nothing reaches them that
// they did not choose. The words may use the record's fields; the wire
// engine fills them before the handler runs.
//
// Someone on the People list who is not a member (a partner, a shop) is
// emailed, or texted when the wire says so, only by a wire, only through the
// workspace's own sender (its email provider, its Twilio account), and only
// once an owner or admin allowed it (platform outboundEmail.sendAutomated,
// which holds the limits and the stop link). A wire that could not do that
// is refused when it is saved, with the reason.

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
  // A wire to someone outside the workspace is refused when it is saved,
  // with the reason, while the workspace cannot message outside it.
  platform().actions.registerWireCheck("core-notifications:message-someone", async ({ orgId, args }) => {
    const to = typeof args.to === "string" ? args.to.trim() : "";
    if (!to || /\{\{/.test(to)) return null;
    if (await platform().accounts.userForPerson(orgId, to)) return null;
    return platform().outboundEmail.automatedRefusal(orgId, args.via === "text" ? "text" : "email");
  });
}

async function messageSomeone(ctx: ActionInvokeContext, entity: ActionInvokeContext["entity"] | null): Promise<unknown> {
  const args = ctx.args ?? {};
  const to = typeof args.to === "string" ? args.to.trim() : "";
  if (!to) return { ok: false, error: "who should get the message? pick a person" };
  const record = entity ? await platform().entities.lookup(ctx.orgId, entity.kind, entity.id).catch(() => null) : null;
  const said = typeof args.message === "string" && args.message.trim() ? args.message.trim() : defaultMessage(record?.title);
  const userId = await platform().accounts.userForPerson(ctx.orgId, to);
  if (!userId) {
    // Outside the workspace: only an automation, through the workspace's own
    // sender, within its limits (the platform's one door for it).
    if (!ctx.wire) return { ok: false, error: "a message to someone outside this workspace is sent only by an automation on an event" };
    const sent = await platform().outboundEmail.sendAutomated(ctx.orgId, {
      wireId: ctx.wire.id,
      personId: to,
      text: said.slice(0, 2000),
      record: entity ? { kind: entity.kind, id: entity.id, title: record?.title ?? null } : null,
      replyLink: args.reply_link === true || args.reply_link === "true",
      via: args.via === "text" ? "text" : "email",
    });
    if (!sent.ok) return sent.status === "stopped" || sent.status === "held" ? { ok: true, skipped: sent.reason } : { ok: false, error: sent.reason };
    return { ok: true, summary: `${args.via === "text" ? "Texted" : "Emailed"} ${sent.name}: ${said.slice(0, 120)}`, activity_label: "Messaged someone" };
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
