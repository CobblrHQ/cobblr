import { meta } from "../db/meta.js";

type Field = { name: string; value: string; inline?: boolean };

// Consistent reporter/context fields for EVERY feedback Discord card (new
// feedback, resolved, batch-resolved): user · workspace · slug · page — so the
// card types can't drift apart again (they used to: new-feedback showed
// workspace+page, resolved showed only page). Best-effort: any lookup that
// misses simply omits its field; never throws into the fire-and-forget announce.
export async function reporterCardFields(opts: {
  userId?: string | null;
  orgId?: string | null;
  route?: string | null;
}): Promise<Field[]> {
  const fields: Field[] = [];

  if (opts.userId) {
    const u = await meta
      .selectFrom("users")
      .select(["display_name", "email"])
      .where("id", "=", opts.userId)
      .executeTakeFirst()
      .catch(() => undefined);
    const who = u?.display_name || u?.email;
    if (who) fields.push({ name: "user", value: who, inline: true });
  }

  // The reporting workspace: the org filed from, else the reporter's first
  // (a stale/missing slug shouldn't drop the breadcrumb).
  let orgId = opts.orgId ?? null;
  if (!orgId && opts.userId) {
    const m = await meta
      .selectFrom("org_memberships")
      .select("org_id")
      .where("user_id", "=", opts.userId)
      .orderBy("joined_at", "asc")
      .executeTakeFirst()
      .catch(() => undefined);
    orgId = m?.org_id ?? null;
  }
  if (orgId) {
    const o = await meta
      .selectFrom("orgs")
      .select(["name", "slug"])
      .where("id", "=", orgId)
      .executeTakeFirst()
      .catch(() => undefined);
    if (o?.name) fields.push({ name: "workspace", value: o.name, inline: true });
    if (o?.slug) fields.push({ name: "slug", value: o.slug, inline: true });
  }

  if (opts.route) fields.push({ name: "page", value: opts.route, inline: true });
  return fields;
}
