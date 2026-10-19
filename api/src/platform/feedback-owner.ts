// Is the person who filed this feedback the operator themselves? A reply to
// the owner's own ticket may send without a second go (#7460); a reply to
// anyone else waits for the owner to publish it.

import { isPlatformAdmin } from "../auth/middleware.js";
import { meta } from "../db/meta.js";

export async function reporterIsOperator(row: {
  user_id: string | null;
  origin_ref: unknown;
}): Promise<boolean> {
  if (row.user_id) {
    const u = await meta.selectFrom("users").select("email").where("id", "=", row.user_id).executeTakeFirst();
    return !!u && isPlatformAdmin(u.email);
  }
  // A DM reporter has no account on the ticket; their Discord id may still be an operator's verified link.
  const discordId = (row.origin_ref as { user_id?: string } | null)?.user_id;
  if (!discordId) return false;
  const linked = await meta
    .selectFrom("discord_connections as d")
    .innerJoin("users as u", "u.id", "d.user_id")
    .select("u.email")
    .where("d.discord_user_id", "=", discordId)
    .where("d.verified", "=", true)
    .execute();
  return linked.some((r) => isPlatformAdmin(r.email));
}
