// The email a share invite sends (#5365): one message, to exactly the address
// the owner typed, once per press, from the workspace (never a person's name
// in the From), with a per-workspace limit. Kept apart from the invite itself
// so its rules are tested without a database; the defaults load theirs lazily.

import { productName } from "./product-name.js";
import type { AuthEmailMessage } from "@cobblr/platform-contract";
import { cobblrEmailHtml } from "./email-html.js";

/** Invite emails one workspace may send in an hour. */
export const INVITE_EMAILS_PER_HOUR = 20;

export type InviteMail = "sent" | "no_mail" | "rate_limited" | "failed";

export interface InviteEmailDeps {
  hasSender: () => boolean | Promise<boolean>;
  send: (msg: AuthEmailMessage) => Promise<boolean>;
  sentInLastHour: (orgId: string) => Promise<number>;
  markSent: (linkId: string) => Promise<void>;
}

export const defaultInviteEmailDeps: InviteEmailDeps = {
  hasSender: async () => (await import("./hosted-seams.js")).hasAuthEmailSender(),
  send: async (msg) => (await import("./hosted-seams.js")).sendAuthEmail(msg),
  sentInLastHour: async (orgId) => {
    const { meta } = await import("../db/meta.js");
    const r = await meta
      .selectFrom("share_links")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("invite_emailed_at", ">", new Date(Date.now() - 3_600_000))
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  },
  markSent: async (linkId) => {
    const { meta } = await import("../db/meta.js");
    await meta.updateTable("share_links").set({ invite_emailed_at: new Date() }).where("id", "=", linkId).execute();
  },
};

export async function emailShareInvite(
  p: { orgId: string; linkId: string; to: string; url: string; workspaceName: string; what: string },
  deps: InviteEmailDeps = defaultInviteEmailDeps,
): Promise<InviteMail> {
  if (!(await deps.hasSender())) return "no_mail";
  if ((await deps.sentInLastHour(p.orgId)) >= INVITE_EMAILS_PER_HOUR) return "rate_limited";
  const rules = `It works once, for a week, and only for ${p.to}.`;
  const ok = await deps.send({
    to: p.to,
    subject: `${p.workspaceName} shared ${p.what} with you on ${productName()}`,
    text:
      `${p.workspaceName} is sharing ${p.what} with you on ${productName()}.\n\n` +
      `Open this link to accept:\n${p.url}\n\n${rules}` +
      `\n\nIf you weren't expecting this, you can ignore this email.`,
    html: cobblrEmailHtml({
      greeting: `${p.workspaceName} is sharing ${p.what} with you on ${productName()}.`,
      bodyParas: [`Open the link to see it in your own ${productName()}. With no account there yet, you sign up first and come back to it.`, rules],
      ctaUrl: p.url,
      ctaLabel: "Accept the invite",
      footerNote: "If you weren't expecting this, you can ignore this email.",
    }),
    kind: "invite",
  });
  if (!ok) return "failed";
  await deps.markSent(p.linkId);
  return "sent";
}

/** The sentence a person reads after Share, on the page or from Cobb. */
export function inviteSaid(made: { email: string | null; mail: InviteMail | null }): string {
  if (!made.email) return "Invite link made. Send it to them yourself.";
  switch (made.mail) {
    case "sent":
      return `Invited ${made.email}: email sent.`;
    case "rate_limited":
      return `Invite link made for ${made.email}. This workspace has sent ${INVITE_EMAILS_PER_HOUR} invite emails in the last hour, so send this one yourself.`;
    case "failed":
      return `Invite link made for ${made.email}, but the email did not go out. Send them the link yourself.`;
    default:
      return `Invite link made for ${made.email}. This server can't send email; send the link yourself.`;
  }
}
