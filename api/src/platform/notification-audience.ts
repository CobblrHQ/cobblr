// Who in a workspace a kind of notification is FOR.
//
// Every workspace-wide notification reached every member, because the
// emitters fan out over the member list and nothing could say otherwise; a
// household workspace with a guest in it told the guest what was going off in
// the fridge (2026-09-07). Channel bindings decide HOW a person is told. This
// decides WHETHER they are one of the people to tell, per kind, per workspace:
// everyone (the default and every existing workspace), the owners only, or
// exactly these people.
//
// Enforced in the dispatcher, not in the emitters. Nine emitters loop the
// member list today and a tenth would too; the one place every workspace
// notification passes through is dispatch(), so that is where a recipient
// outside the audience is dropped, before any row is written. `audienceFor`
// is offered to emitters as well, so a sweep can skip composing a message
// nobody will receive.

import { meta } from "../db/meta.js";
import { resolveAudience, type AudienceRule, type MemberRow } from "./notification-audience-rule.js";

export { resolveAudience, type AudienceRule, type MemberRow };

/** Rules are read on every dispatch, so they are cached briefly per
 *  workspace. A change on the settings page is visible within a minute,
 *  and the page itself reads through the same cache so it never shows a
 *  stale value after its own save. */
const RULES_TTL_MS = 60_000;
const rulesCache = new Map<string, { at: number; rules: Map<string, AudienceRule> }>();

export function forgetAudienceRules(orgId: string): void {
  rulesCache.delete(orgId);
}

export async function audienceRules(orgId: string): Promise<Map<string, AudienceRule>> {
  const hit = rulesCache.get(orgId);
  if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit.rules;
  const rows = await meta
    .selectFrom("notification_audiences")
    .select(["event_type", "mode", "user_ids"])
    .where("org_id", "=", orgId)
    .execute();
  const rules = new Map<string, AudienceRule>();
  for (const r of rows) {
    const ids = Array.isArray(r.user_ids) ? (r.user_ids as unknown[]).filter((v): v is string => typeof v === "string") : [];
    rules.set(r.event_type, { mode: r.mode, userIds: ids });
  }
  rulesCache.set(orgId, { at: Date.now(), rules });
  return rules;
}

async function membersOf(orgId: string): Promise<MemberRow[]> {
  return meta
    .selectFrom("org_memberships")
    .select(["user_id", "role"])
    .where("org_id", "=", orgId)
    .execute()
    .then((rows) => rows.map((r) => ({ user_id: String(r.user_id), role: String(r.role) })));
}

/** The people a kind of notification is for, in this workspace, right now. */
export async function audienceFor(orgId: string, eventType: string): Promise<string[]> {
  const [rules, members] = await Promise.all([audienceRules(orgId), membersOf(orgId)]);
  return resolveAudience(rules.get(eventType) ?? null, members);
}

/** Is this person one of the people this kind is for? The dispatcher's
 *  question, answered from the same rule the settings page shows. */
export async function inAudience(orgId: string, eventType: string, userId: string): Promise<boolean> {
  const rules = await audienceRules(orgId);
  const rule = rules.get(eventType);
  if (!rule || rule.mode === "all") return true;
  const members = await membersOf(orgId);
  return resolveAudience(rule, members).includes(String(userId));
}

export async function setAudience(orgId: string, eventType: string, rule: AudienceRule): Promise<void> {
  if (rule.mode === "all") {
    // Everyone is the absence of a rule, so a workspace put back to the
    // default carries no row and reads like one that was never configured.
    await meta.deleteFrom("notification_audiences").where("org_id", "=", orgId).where("event_type", "=", eventType).execute();
  } else {
    await meta
      .insertInto("notification_audiences")
      .values({
        org_id: orgId,
        event_type: eventType,
        mode: rule.mode,
        // jsonb-array-ok: the house convention for a jsonb ARRAY.
        user_ids: JSON.stringify(rule.mode === "custom" ? rule.userIds : []) as never,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(["org_id", "event_type"]).doUpdateSet({
          mode: rule.mode,
          user_ids: JSON.stringify(rule.mode === "custom" ? rule.userIds : []) as never,
          updated_at: new Date(),
        }),
      )
      .execute();
  }
  forgetAudienceRules(orgId);
}
