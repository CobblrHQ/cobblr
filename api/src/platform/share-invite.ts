// Inviting someone new into a share (#5365): the one door for the share page,
// Settings → Sharing and the share action Cobb runs.
//
// The owner types the person's email, or nothing. With an email, the invite
// is bound to it (only an account with that address can pair) and, when this
// Cobblr has outgoing mail, it is emailed there (share-invite-email.ts).
// Without one, or without mail, the owner gets the link to send themselves.
// Either way the link comes back, in case the email lands in spam.

import { pluralise } from "@cobblr/platform-contract";
import { kindWordsFrom } from "@cobblr/platform-contract/kind-label";
import { meta } from "../db/meta.js";
import { inviteLinks, type InviteDestination } from "./cloud.js";
import { listKindsForOrg } from "./entities.js";
import { createShareInvite } from "./share-links.js";
import { defaultInviteEmailDeps, emailShareInvite, type InviteEmailDeps, type InviteMail } from "./share-invite-email.js";

export interface InviteMade {
  linkId: string;
  /** The link for the place the owner chose, and every place it could open. */
  url: string;
  links: Array<InviteDestination & { url: string }>;
  expiresAt: Date;
  email: string | null;
  /** What happened to the email; null when no address was given. */
  mail: InviteMail | null;
}

/** What an invite shares, in the words its email and its page use. */
export async function describeInviteScope(orgId: string, collection?: { kind: string; ids?: string[] }): Promise<string> {
  if (!collection) return "a shared workspace";
  const words = kindWordsFrom(collection.kind, await listKindsForOrg(orgId).catch(() => []), pluralise);
  const ids = collection.ids ?? [];
  if (!ids.length) return `${words.many}: every current and future record`;
  return ids.length === 1 ? `a ${words.one}` : `${ids.length} ${words.many}`;
}

/** Make the invite, and email it when an address was given and this Cobblr
 *  can send mail. `where` picks the place the owner said their Cobblr is. */
export async function inviteToShare(
  p: { orgId: string; userId: string; here: string; email?: string | null; label?: string; where?: number; collection?: { kind: string; ids?: string[] } },
  deps: InviteEmailDeps = defaultInviteEmailDeps,
): Promise<InviteMade> {
  const email = p.email?.trim().toLowerCase() || null;
  const made = await createShareInvite({ orgId: p.orgId, userId: p.userId, label: p.label?.trim() || email || "", email, here: p.here, collection: p.collection });
  const links = inviteLinks(p.here, made.token);
  const url = links[p.where ?? 0]?.url ?? links[0]?.url ?? made.inviteUrl;
  let mail: InviteMail | null = null;
  if (email) {
    const org = await meta.selectFrom("orgs").select("name").where("id", "=", p.orgId).executeTakeFirst();
    mail = await emailShareInvite({ orgId: p.orgId, linkId: made.linkId, to: email, url, workspaceName: org?.name ?? "A Cobblr workspace", what: await describeInviteScope(p.orgId, p.collection) }, deps);
  }
  return { linkId: made.linkId, url, links, expiresAt: made.expiresAt, email, mail };
}
