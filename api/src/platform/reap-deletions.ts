// Drop the workspaces their owners asked to delete, once the grace period is
// over. The request is POST /orgs/:slug/deletion (routes/orgs.ts), which stamps
// `orgs.deletion_due_at`; until that day the workspace works as before, every
// member is shown the date, and an owner can keep it, which clears the stamp.
//
// Before each drop it takes the workspace's final backup
// (workspace-final-export.ts), which every owner can download from their
// account for 30 days. No backup, no drop: a workspace whose backup failed is
// left as it is and tried again next sweep, so nothing is ever gone without a
// copy. The same sweep removes the kept backups whose time is up.
//
// It deletes, so it is careful in the same ways the trial reaper is:
//   - only a workspace with a due date in the past is a candidate, and the
//     pure filter re-checks that whatever the query returned;
//   - one process at a time (runExclusive), because two apis against one
//     database (the canary channel, a rolling deploy) must not race a drop;
//   - a cap per sweep: more due than that at once means a bad clock or a bad
//     migration, not a normal day, so the sweep deletes nothing and says so.
//
// COBBLR_WORKSPACE_DELETE_REAP=off stops it (for an operator restoring a
// database that is days old, whose due dates are suddenly in the past).
//
// meta and hardDeleteOrg are imported lazily: importing ../db/meta.js checks
// the environment and exits without it, which would take down a unit test
// that only wants the pure helpers.

import { runExclusive } from "./exclusive.js";

import { countOf } from "@cobblr/platform-contract/plural";
/** Days between asking and the drop, fail-safe: a missing or non-numeric
 *  value is 14, never NaN (a NaN due date would be never, or now). Pure. */
export function deletionGraceDays(env: NodeJS.ProcessEnv = process.env): number {
  const g = Number(env.COBBLR_WORKSPACE_DELETE_GRACE_DAYS);
  return Number.isFinite(g) && g >= 0 ? g : 14;
}

/** Hourly, fail-safe: a value under a minute or not a number is an hour, never
 *  a hot loop of a destructive sweep. Pure. */
export function deletionReapIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const i = Number(env.COBBLR_WORKSPACE_DELETE_REAP_INTERVAL_MS);
  return Number.isFinite(i) && i >= 60_000 ? i : 3_600_000;
}

/** At most this many drops in one sweep; more due at once and the sweep drops
 *  nothing. 0 means no cap. Fail-safe to 10. Pure. */
export function deletionReapMax(env: NodeJS.ProcessEnv = process.env): number {
  const m = Number(env.COBBLR_WORKSPACE_DELETE_REAP_MAX);
  return Number.isFinite(m) && m >= 0 ? m : 10;
}

export interface DeletionCandidate {
  id: string;
  slug: string;
  deletion_due_at: Date | string | null;
}

/** The workspaces whose day has come. A null or unreadable date is never due. Pure. */
export function dueForDeletion(orgs: DeletionCandidate[], nowMs: number): DeletionCandidate[] {
  return orgs.filter((o) => {
    if (o.deletion_due_at == null) return false;
    const t = new Date(o.deletion_due_at).getTime();
    return Number.isFinite(t) && t <= nowMs;
  });
}

export interface DeletionReapDeps {
  listCandidates?: () => Promise<DeletionCandidate[]>;
  /** The final backup; throws unless it landed. */
  exportOrg?: (orgId: string) => Promise<unknown>;
  deleteOrg?: (orgId: string) => Promise<void>;
  now?: number;
  max?: number;
}

export interface DeletionReapResult {
  due: number;
  deleted: string[];
  /** Due, but kept this sweep because the final backup did not land. */
  kept: string[];
  /** Set when the cap refused the whole sweep. */
  refused?: string;
}

async function defaultCandidates(): Promise<DeletionCandidate[]> {
  const { meta } = await import("../db/meta.js");
  return meta
    .selectFrom("orgs")
    .select(["id", "slug", "deletion_due_at"])
    .where("deletion_due_at", "is not", null)
    .where("deletion_due_at", "<=", new Date())
    .execute();
}

export async function reapRequestedDeletions(deps: DeletionReapDeps = {}): Promise<DeletionReapResult> {
  const now = deps.now ?? Date.now();
  const max = deps.max ?? deletionReapMax();
  const due = dueForDeletion(await (deps.listCandidates ?? defaultCandidates)(), now);
  if (max > 0 && due.length > max) {
    const refused = `${countOf(due.length, "workspace")} are due at once, over the cap of ${max}; nothing was deleted. Check the clock and the deletion_due_at stamps, then raise COBBLR_WORKSPACE_DELETE_REAP_MAX for one sweep if they are right.`;
    console.error(`[reap-deletions] ${refused}`);
    return { due: due.length, deleted: [], kept: [], refused };
  }
  const drop =
    deps.deleteOrg ??
    (async (orgId: string) => {
      const { hardDeleteOrg } = await import("./delete-org.js");
      await hardDeleteOrg(orgId);
    });
  const exportOrg =
    deps.exportOrg ??
    (async (orgId: string) => {
      const { takeFinalExport } = await import("./workspace-final-export.js");
      return takeFinalExport(orgId);
    });
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const o of due) {
    try {
      await exportOrg(o.id);
    } catch (err) {
      kept.push(o.id);
      console.error(
        `[reap-deletions] workspace ${o.slug} (${o.id}) kept: its final backup did not land, so it is not dropped (${(err as Error).message})`,
      );
      continue;
    }
    try {
      await drop(o.id);
      deleted.push(o.id);
      console.log(`[reap-deletions] deleted workspace ${o.slug} (${o.id}), due ${new Date(o.deletion_due_at!).toISOString()}`);
    } catch (err) {
      console.error(`[reap-deletions] workspace ${o.slug} (${o.id}) not deleted: ${(err as Error).message}`);
    }
  }
  return { due: due.length, deleted, kept };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDeletionReaper(): void {
  if (String(process.env.COBBLR_WORKSPACE_DELETE_REAP ?? "").trim().toLowerCase() === "off") {
    console.log("[reap-deletions] off (COBBLR_WORKSPACE_DELETE_REAP=off): workspaces past their deletion date are kept");
    return;
  }
  if (timer) return;
  const run = () =>
    // SKIP-IF-BUSY OK: a timer tick; the holder reaps, the next tick finds what is still due
    runExclusive("platform.reap-deletions", async () => {
      await reapRequestedDeletions();
      const { expireFinalExports } = await import("./workspace-final-export.js");
      await expireFinalExports();
    }).catch((err) => console.error("[reap-deletions] sweep failed:", (err as Error).message));
  void run();
  timer = setInterval(run, deletionReapIntervalMs());
}
