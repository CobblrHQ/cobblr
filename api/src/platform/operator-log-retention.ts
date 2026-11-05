// The operator's record of support sessions and console deletes is kept for a
// year and then removed (#9234; docs/modules/operator-impersonation.md 3.3).
// It outlives the workspace it names, but not forever: it holds who looked and
// why, and the name of a workspace someone asked to have removed.
import { meta } from "../db/meta.js";
import { runExclusive } from "./exclusive.js";

import { OPERATOR_LOG_DAYS, operatorLogCutoff } from "./operator-log-days.js";

export { OPERATOR_LOG_DAYS };

/** Remove what is past its year. A session still open is never removed. */
export async function pruneOperatorLog(now = new Date()): Promise<{ sessions: number; actions: number }> {
  const cutoff = operatorLogCutoff(now);
  const sessions = await meta
    .deleteFrom("impersonation_sessions")
    .where("created_at", "<", cutoff)
    .where((eb) => eb.or([eb("ended_at", "is not", null), eb("expires_at", "<", now)]))
    .executeTakeFirst();
  const actions = await meta.deleteFrom("operator_actions").where("created_at", "<", cutoff).executeTakeFirst();
  return { sessions: Number(sessions.numDeletedRows), actions: Number(actions.numDeletedRows) };
}

/** Write what an operator removed from the console. The name is kept only for a workspace. */
export async function recordOperatorAction(a: { operatorUserId: string; action: "workspace_deleted" | "user_deleted"; subjectKind: "workspace" | "user"; subjectId: string; subjectName?: string | null }): Promise<void> {
  await meta
    .insertInto("operator_actions")
    .values({ operator_user_id: a.operatorUserId, action: a.action, subject_kind: a.subjectKind, subject_id: a.subjectId, subject_name: a.subjectName ?? null })
    .execute();
}

/** Before a workspace's rows go: its View as rows keep its name and address. */
export async function snapshotWorkspaceOnSessions(trx: typeof meta, orgId: string): Promise<void> {
  await trx
    .updateTable("impersonation_sessions")
    .set((eb) => ({
      workspace_name: eb.selectFrom("orgs").select("name").where("id", "=", orgId),
      workspace_slug: eb.selectFrom("orgs").select("slug").where("id", "=", orgId),
    }))
    .where("org_id", "=", orgId)
    .execute();
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startOperatorLogRetention(): void {
  if (timer) return;
  const run = () =>
    // SKIP-IF-BUSY OK: a daily tick; the holder prunes, and what's left is pruned tomorrow
    runExclusive("platform.operator-log-retention", async () => {
      const r = await pruneOperatorLog();
      if (r.sessions || r.actions) console.log(`[operator-log] removed ${r.sessions} View as row(s) and ${r.actions} console delete(s) past ${OPERATOR_LOG_DAYS} days`);
    }).catch((err) => console.error("[operator-log] retention failed:", (err as Error).message));
  void run();
  timer = setInterval(run, 24 * 60 * 60 * 1000);
}

