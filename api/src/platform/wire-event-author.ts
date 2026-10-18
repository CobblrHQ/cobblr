// The event as an automation's author may read it: the part of
// wire-event-scope.ts that needs the database (who the author is, what they hold).

import { meta } from "../db/meta.js";
import { effectiveCapabilities, type EffectiveCapabilities } from "../auth/effective-capabilities.js";
import { baseKindOf, fieldReadScopesOf } from "./entities.js";
import { fieldsHiddenFrom, withoutFields } from "./wire-event-scope.js";

/** The fields of a kind that its author may not read (empty when the kind has no scopes). */
export async function fieldsHiddenFromAuthor(orgId: string, sourceKind: string, authorId: string | null): Promise<string[]> {
  const base = await baseKindOf(orgId, sourceKind).catch(() => sourceKind);
  const scopes = await fieldReadScopesOf(base, orgId);
  if (!scopes || Object.keys(scopes).length === 0) return [];
  let caps: EffectiveCapabilities | null = null;
  if (authorId) {
    const member = await meta.selectFrom("org_memberships").select("role").where("org_id", "=", orgId).where("user_id", "=", authorId).executeTakeFirst();
    caps = member ? await effectiveCapabilities(orgId, authorId, member.role) : null;
  }
  return fieldsHiddenFrom(scopes, caps);
}

/** The event as the automation's author may read it. */
export async function eventForAuthor<T extends Record<string, unknown>>(orgId: string, sourceKind: string, authorId: string | null, event: T): Promise<T> {
  return withoutFields(event, await fieldsHiddenFromAuthor(orgId, sourceKind, authorId));
}
