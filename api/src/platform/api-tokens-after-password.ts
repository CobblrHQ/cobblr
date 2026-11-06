// A new password ends a person's sessions, not their API tokens: a bridge or an automation dying with no warning is
// its own harm. So the confirmation names the tokens that still work and offers to end them; nothing ends unasked.
import { meta } from "../db/meta.js";
import { log as activityLog } from "./activity.js";

export interface TokensStillWorking {
  count: number;
  items: Array<{ id: string; name: string }>;
  /** "2 API tokens still work: Bridge, Label printer." Null when there are none. */
  message: string | null;
}

export async function apiTokensStillWorking(userId: string): Promise<TokensStillWorking> {
  const now = new Date();
  const items = await meta
    .selectFrom("api_tokens")
    .select(["id", "name"])
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
    .orderBy("created_at", "asc")
    .execute();
  const names = items.map((t) => t.name).join(", ");
  const message = items.length === 0 ? null : items.length === 1 ? `1 API token still works: ${names}.` : `${items.length} API tokens still work: ${names}.`;
  return { count: items.length, items, message };
}

/** For a new password's answer, given after the password has changed: a failed read here must not turn that success
 *  into a 500 with the reset link already spent. Null means nobody could tell, never that there are none. */
export async function apiTokensStillWorkingAfterChange(userId: string): Promise<TokensStillWorking | null> {
  try {
    return await apiTokensStillWorking(userId);
  } catch (err) {
    console.error(`[api-tokens] could not read the tokens still working for ${userId}:`, (err as Error).message);
    return null;
  }
}

/** Ends every token of this person's that still works, and says which. */
export async function endApiTokens(userId: string): Promise<{ ended: number; names: string[] }> {
  const now = new Date();
  const rows = await meta
    .updateTable("api_tokens")
    .set({ revoked_at: now })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
    .returning("name")
    .execute();
  return { ended: rows.length, names: rows.map((r) => r.name) };
}

/** The one way they end: through the page, the API and the action alike, on the person's record. */
export async function endApiTokensAndLog(userId: string, reason?: string | null): Promise<{ ended: number; names: string[] }> {
  const ended = await endApiTokens(userId);
  const firstOrg = await meta.selectFrom("org_memberships").select("org_id").where("user_id", "=", userId).limit(1).executeTakeFirst();
  if (firstOrg && ended.ended > 0) {
    await activityLog({ orgId: firstOrg.org_id, userId, action: "api_tokens_ended", ref: { module: null, entityType: "user", entityId: userId }, diff: { names: ended.names, ...(reason ? { reason } : {}) } })
      .catch((err) => console.error("[api-tokens] activity log failed:", err));
  }
  return ended;
}

export const endedSentence = (ended: { ended: number; names: string[] }): string =>
  ended.ended === 0 ? "You have no API tokens that still work." : `Ended ${ended.ended === 1 ? "1 API token" : `${ended.ended} API tokens`}: ${ended.names.join(", ")}.`;
