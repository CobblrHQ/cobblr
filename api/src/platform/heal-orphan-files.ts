// One-shot heal, DRY RUN: the files of workspaces deleted before a workspace
// delete erased them.
//
// DONE WHEN: `heal_shims` for this file reads found 0 on every
// deployment that runs it (GET /api/v1/healthz, or
// scripts/deploy-gap.sh). Then delete this file, its boot call and the
// `orphan_files` field of /healthz.
// BORN WITH: nothing (a workspace made today has no deleted predecessor whose
// files it could leave behind; deletes erase their own files since
// hardDeleteOrg called platform().files.eraseWorkspace).
//
// WHY IT EXISTS. Deleting a workspace dropped its database and left every file
// it stored under the file store for good: an owner's delete, an account
// delete, the trial reaper, and every try-it sandbox. That is a privacy
// problem (the files of somebody who deleted everything are still there) and
// a disk that only grows.
//
// THIS STEP ONLY COUNTS. It lists the folders whose workspace no longer
// exists, splits off any written to in the last 30 days (a restore may still
// want them), and reports the count and bytes: a log line, the heal-shim
// ledger, and `orphan_files` on /healthz, so each surface's numbers can be read
// before anything is erased. The erase is a separate, later change, made once
// those numbers are in. A folder whose workspace exists is never counted.

// meta and the shim ledger are imported lazily: importing ../db/meta.js checks
// the environment and exits without it, which would take down the unit test
// of the pure rule below.
import { platform, type WorkspaceFolder } from "@cobblr/platform-contract";

const KEEP_DAYS = 30;

export interface OrphanFilesReport {
  at: string;
  mode: "dry_run";
  /** Null when the file store cannot be listed this way (object storage). */
  listable: boolean;
  /** Folders whose workspace is gone and untouched for KEEP_DAYS: what the erase would remove. */
  orphan_dirs: number;
  orphan_bytes: number;
  /** Gone, but written to within KEEP_DAYS: kept either way. */
  recent_dirs: number;
  recent_bytes: number;
  /** Folders of workspaces that exist: never touched. */
  live_dirs: number;
}

/** Split the store's folders by whether their workspace exists and how
 *  recently they were written. Pure. */
export function classifyFolders(folders: WorkspaceFolder[], existing: Set<string>, nowMs: number, keepDays = KEEP_DAYS) {
  const cutoff = nowMs - keepDays * 86_400_000;
  const orphans: WorkspaceFolder[] = [];
  const recent: WorkspaceFolder[] = [];
  let live = 0;
  for (const f of folders) {
    if (existing.has(f.orgId.toLowerCase())) live++;
    else if (f.newestAt >= cutoff) recent.push(f);
    else orphans.push(f);
  }
  return { orphans, recent, live };
}

let last: OrphanFilesReport | null = null;
export function lastOrphanFilesReport(): OrphanFilesReport | null {
  return last;
}

export async function auditOrphanFiles(now: Date = new Date()): Promise<OrphanFilesReport> {
  const { meta } = await import("../db/meta.js");
  const { noteHealShim } = await import("./heal-shim-log.js");
  const folders = await platform().files.listWorkspaceFolders();
  const existing = new Set((await meta.selectFrom("orgs").select("id").execute()).map((o) => o.id.toLowerCase()));
  const c = classifyFolders(folders ?? [], existing, now.getTime());
  const sum = (xs: WorkspaceFolder[]) => xs.reduce((n, f) => n + f.bytes, 0);
  last = {
    at: now.toISOString(),
    mode: "dry_run",
    listable: folders !== null,
    orphan_dirs: c.orphans.length,
    orphan_bytes: sum(c.orphans),
    recent_dirs: c.recent.length,
    recent_bytes: sum(c.recent),
    live_dirs: c.live,
  };
  console.log(
    `[heal] orphan file folders (dry run, nothing erased): ${last.orphan_dirs} folders, ${last.orphan_bytes} bytes of deleted workspaces; ${last.recent_dirs} more (${last.recent_bytes} bytes) written within ${KEEP_DAYS} days are kept; ${last.live_dirs} live`,
  );
  if (folders !== null) await noteHealShim("api/src/platform/heal-orphan-files.ts", last.orphan_dirs);
  return last;
}

/** At boot, after the api is serving: counting a large store must not hold up
 *  the first request. */
export function startOrphanFilesAudit(delayMs = 60_000): void {
  const t = setTimeout(() => {
    void auditOrphanFiles().catch((err) => console.error("[heal] orphan file folders: audit failed:", (err as Error).message));
  }, delayMs);
  t.unref?.();
}
