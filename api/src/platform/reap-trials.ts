// Reap expired trial / demo workspaces.
//
// provisionOrgForUser stamps `orgs.trial_expires_at` on the trial tier (and, later, on
// pushed demo workspaces) — but nothing sweeps it, so abandoned trials pile up. This is
// the sweep. It is DESTRUCTIVE (drops the tenant DB via hardDeleteOrg), so it is gated
// hard:
//   • COBBLR_TRIAL_REAP = off (default) | dry | live
//       off  — never runs.
//       dry  — logs exactly what WOULD be reaped, deletes nothing (run this first).
//       live — reaps workspaces whose stamp is past the grace window.
//   • COBBLR_TRIAL_REAP_GRACE_DAYS (default 3) — extra days past trial_expires_at.
//   • ONLY orgs with `trial_expires_at IS NOT NULL` are ever candidates — prod /
//     staging / self-host leave it NULL everywhere, so they can't be touched even in
//     `live` (belt: the pure filter re-checks null).
//
// Slice 1 of the central-identity / demo-workspaces work (see
// _tmp/central-identity-and-demo-workspaces.md); the demo feature reuses this same
// stamp + sweep.

// meta + hardDeleteOrg are imported LAZILY inside the real code paths — importing
// ../db/meta.js validates env and process.exit(1)s when it's absent, which would take
// down any unit test (or test:unit) that merely imports this module. The pure helpers
// + the injected-deps orchestration stay import-clean.

export type ReapMode = "off" | "dry" | "live";

/** off | dry | live from COBBLR_TRIAL_REAP (default off; unknown → off). Pure. */
export function reapMode(env: NodeJS.ProcessEnv = process.env): ReapMode {
  const v = String(env.COBBLR_TRIAL_REAP ?? "off").trim().toLowerCase();
  return v === "live" ? "live" : v === "dry" ? "dry" : "off";
}

export interface TrialOrg {
  id: string;
  slug: string;
  trial_expires_at: Date | string | null;
}

/** The orgs safe to reap: a trial stamp that is past (expiry + grace). Pure + the
 *  safety gate — a NULL stamp is NEVER reapable, whatever the query returned. */
export function reapableOrgs(orgs: TrialOrg[], graceDays: number, nowMs: number): TrialOrg[] {
  const cutoff = nowMs - Math.max(graceDays, 0) * 86_400_000;
  return orgs.filter((o) => {
    if (o.trial_expires_at == null) return false;
    const t = new Date(o.trial_expires_at).getTime();
    return Number.isFinite(t) && t < cutoff;
  });
}

async function defaultListTrialOrgs(): Promise<TrialOrg[]> {
  const { meta } = await import("../db/meta.js");
  return meta
    .selectFrom("orgs")
    .select(["id", "slug", "trial_expires_at"])
    .where("trial_expires_at", "is not", null)
    .execute() as Promise<TrialOrg[]>;
}

export interface ReapDeps {
  listTrialOrgs?: () => Promise<TrialOrg[]>;
  deleteOrg?: (orgId: string) => Promise<void>;
  now?: number;
  graceDays?: number;
}

/** One sweep. Returns what it saw + did. Never throws for a single org — a failed
 *  teardown is logged and the sweep continues (resilient, like the boot reconciles). */
export async function reapExpiredTrials(deps: ReapDeps = {}): Promise<{
  mode: ReapMode;
  found: number;
  reaped: number;
}> {
  const mode = reapMode();
  if (mode === "off") return { mode, found: 0, reaped: 0 };

  const listTrialOrgs = deps.listTrialOrgs ?? defaultListTrialOrgs;
  const now = deps.now ?? Date.now();
  const graceDays = deps.graceDays ?? Number(process.env.COBBLR_TRIAL_REAP_GRACE_DAYS || 3);

  const reapable = reapableOrgs(await listTrialOrgs(), graceDays, now);
  if (reapable.length === 0) return { mode, found: 0, reaped: 0 };

  if (mode === "dry") {
    for (const o of reapable) console.log(`[reap-trials] DRY-RUN would reap ${o.slug} (${o.id}) — trial_expires_at ${new Date(o.trial_expires_at as Date | string).toISOString()}`);
    console.log(`[reap-trials] DRY-RUN: ${reapable.length} workspace(s) past grace — set COBBLR_TRIAL_REAP=live to enact`);
    return { mode, found: reapable.length, reaped: 0 };
  }

  const deleteOrg = deps.deleteOrg ?? (await import("./delete-org.js")).hardDeleteOrg;
  let reaped = 0;
  for (const o of reapable) {
    try {
      await deleteOrg(o.id);
      reaped++;
      console.log(`[reap-trials] reaped expired workspace ${o.slug} (${o.id})`);
    } catch (err) {
      console.error(`[reap-trials] FAILED to reap ${o.slug} (${o.id}):`, (err as Error).message);
    }
  }
  console.log(`[reap-trials] reaped ${reaped}/${reapable.length} expired workspace(s)`);
  return { mode, found: reapable.length, reaped };
}

let timer: NodeJS.Timeout | null = null;

/** Start the periodic sweep. No-op unless COBBLR_TRIAL_REAP is dry|live. Runs one pass
 *  on boot, then every COBBLR_TRIAL_REAP_INTERVAL_MS (default 6h). */
export function startTrialReaper(): void {
  const mode = reapMode();
  if (mode === "off") return;
  const intervalMs = Math.max(Number(process.env.COBBLR_TRIAL_REAP_INTERVAL_MS || 6 * 3_600_000), 60_000);
  const graceDays = Number(process.env.COBBLR_TRIAL_REAP_GRACE_DAYS || 3);
  const run = () =>
    reapExpiredTrials().catch((err) => console.error("[reap-trials] sweep failed:", (err as Error).message));
  void run(); // initial pass at boot
  timer = setInterval(run, intervalMs);
  console.log(`[reap-trials] started — mode=${mode}, grace=${graceDays}d, every ${Math.round(intervalMs / 3_600_000)}h`);
}

export function stopTrialReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
