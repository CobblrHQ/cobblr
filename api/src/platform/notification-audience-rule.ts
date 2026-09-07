// The audience RULE, pure. Its own module because the module beside it reads
// the meta database, and importing that pulls env validation, which exits the
// process when the environment is incomplete; the decision worth testing is
// this one, and it is testable with nothing running (same split as
// discord-card.ts beside discord-dm.ts).

export type NotificationAudienceMode = "all" | "owners" | "custom";

export interface AudienceRule {
  mode: NotificationAudienceMode;
  userIds: string[];
}

export interface MemberRow {
  user_id: string;
  role: string;
}

/** The rule applied to live membership.
 *  A `custom` list is intersected with membership, so a person removed from
 *  the workspace drops out of the audience without anyone editing it. */
export function resolveAudience(rule: AudienceRule | null | undefined, members: readonly MemberRow[]): string[] {
  const ids = members.map((m) => String(m.user_id));
  if (!rule || rule.mode === "all") return ids;
  if (rule.mode === "owners") return members.filter((m) => m.role === "owner").map((m) => String(m.user_id));
  const chosen = new Set(rule.userIds.map(String));
  return ids.filter((id) => chosen.has(id));
}
