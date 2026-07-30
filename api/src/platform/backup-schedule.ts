// Pure backup-schedule helpers — no DB / env imports, so they're unit-testable
// without a database.

/** True when a scheduled tick should be SKIPPED because a backup already ran
 *  within most of this schedule's interval — the guard that stops boot re-seeds
 *  and blue-green double-processing from firing a pile of duplicate backups. A
 *  legitimate on-cadence run (a full interval later) is never skipped. */
export function isRedundantScheduledRun(schedule: string, lastRunAt: Date | null, now: Date): boolean {
  const minGapMs = schedule === "daily" ? 20 * 3_600_000 : schedule === "weekly" ? 6 * 24 * 3_600_000 : 0;
  if (!lastRunAt || minGapMs === 0) return false;
  return now.getTime() - lastRunAt.getTime() < minGapMs;
}
