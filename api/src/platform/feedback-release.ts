// What resolving a feedback item may do by itself (#7460).
//
// A resolve by an API token (the agents' door) used to post the public summary
// to the public Discord feedback channel and message the reporter in the same
// call. Posting to a public channel is the owner's, every time, and so is a
// message to a reporter who is not the owner. So a resolve STORES the summary
// and the reply, and the owner's publish sends them. The two rules live here,
// pure, so the resolve routes and the tests cannot drift apart.

export interface ReleaseCaller {
  auth_method?: string;
}

/** An API token is an agent, scoped or not; only a signed-in person is the owner at the console. */
export function callerIsAgent(session: ReleaseCaller | undefined): boolean {
  return session?.auth_method !== "session";
}

/** The public changelog line is never posted by a resolve, whoever calls it. */
export const RESOLVE_POSTS_PUBLICLY = false;

/** Whether a resolve may message the reporter now. A person at the console may;
 *  an agent may only when the reporter is the owner or operator themselves. */
export function resolveMayReplyNow(i: { callerIsAgent: boolean; reporterIsOperator: boolean }): boolean {
  return !i.callerIsAgent || i.reporterIsOperator;
}

/** The line the public card carries: the changelog note, else the reply (the older fallback). */
export function summaryToHold(i: { public_summary?: string | null; reply_message?: string | null }): string | null {
  return i.public_summary?.trim() || i.reply_message?.trim() || null;
}
