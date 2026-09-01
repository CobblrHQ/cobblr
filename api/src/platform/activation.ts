// The activation funnel, as arithmetic.
//
// Signup → first item → first scan → came back in week two. Four numbers per
// cohort, computed from facts the read side already fetched, so the rule for
// what counts lives in one pure function that a test can hold to account.
//
// What is deliberately EXCLUDED from a cohort:
//   - founder workspaces (a platform admin is a member): the founder hitting
//     no walls and returning daily proves nothing about a stranger.
//   - sandboxes (try.cobblr): an hour-long throwaway is not a signup.
//   - the CI test-org pool.
// They still appear in the per-workspace table, flagged, so nothing is hidden;
// they just do not count toward the percentages the strategy is judged on.

export interface WorkspaceActivation {
  org_id: string;
  created_at: Date;
  first_item_at: Date | null;
  first_scan_at: Date | null;
  /** Distinct UTC days with a session-authenticated request. */
  active_days: number;
  last_active_day: string | null;
  /** Any active day on or after day 7 from signup. Null until the workspace is
   *  old enough for the question to have an answer. */
  returned_week2: boolean | null;
  founder: boolean;
  sandbox: boolean;
  test_pool: boolean;
}

export interface CohortFunnel {
  /** Workspaces created inside the window (founder/sandbox/pool excluded). */
  signups: number;
  first_item: number;
  /** First item within 24h of signup: the "first success" the pitch promises. */
  first_item_24h: number;
  first_scan: number;
  /** Workspaces old enough (7+ days) for week-two return to be knowable. */
  week2_eligible: number;
  returned_week2: number;
}

export const DAY_MS = 86_400_000;

/** Facts the read side gathers per workspace, before the funnel rule applies. */
export interface WorkspaceFacts {
  org_id: string;
  created_at: Date;
  first_item_at: Date | null;
  first_scan_at: Date | null;
  /** Distinct UTC days the workspace saw a session request, and the last one
   *  (YYYY-MM-DD). The latest day is enough to know whether anyone came back
   *  after day 7: if the latest is past the line, some day is. */
  active_day_count: number;
  last_active_day: string | null;
  founder: boolean;
  sandbox: boolean;
  test_pool: boolean;
}

export function activationOf(f: WorkspaceFacts, now: Date): WorkspaceActivation {
  const createdDay = utcDayOf(f.created_at);
  const eligible = now.getTime() - f.created_at.getTime() >= 7 * DAY_MS;
  const returned = f.last_active_day !== null && dayDiff(createdDay, f.last_active_day) >= 7;
  return {
    org_id: f.org_id,
    created_at: f.created_at,
    first_item_at: f.first_item_at,
    first_scan_at: f.first_scan_at,
    active_days: f.active_day_count,
    last_active_day: f.last_active_day,
    // A return counts as soon as it happens, even before day 7 has fully
    // elapsed for the cohort; only the absence of one waits for eligibility.
    returned_week2: returned ? true : eligible ? false : null,
    founder: f.founder,
    sandbox: f.sandbox,
    test_pool: f.test_pool,
  };
}

export function countsToward(w: WorkspaceActivation): boolean {
  return !w.founder && !w.sandbox && !w.test_pool;
}

/** The funnel for workspaces created in the last `windowDays` (0 = all time). */
export function cohortFunnel(all: WorkspaceActivation[], now: Date, windowDays: number): CohortFunnel {
  const since = windowDays > 0 ? now.getTime() - windowDays * DAY_MS : -Infinity;
  const cohort = all.filter((w) => countsToward(w) && w.created_at.getTime() >= since);
  const f: CohortFunnel = {
    signups: cohort.length,
    first_item: 0,
    first_item_24h: 0,
    first_scan: 0,
    week2_eligible: 0,
    returned_week2: 0,
  };
  for (const w of cohort) {
    if (w.first_item_at) {
      f.first_item++;
      if (w.first_item_at.getTime() - w.created_at.getTime() <= DAY_MS) f.first_item_24h++;
    }
    if (w.first_scan_at) f.first_scan++;
    if (w.returned_week2 !== null) f.week2_eligible++;
    if (w.returned_week2 === true) f.returned_week2++;
  }
  return f;
}

export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayDiff(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}
