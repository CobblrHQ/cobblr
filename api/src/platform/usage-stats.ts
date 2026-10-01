// Usage across one deployment, in the last 1, 7 and 30 days: how many people
// signed up and came back, how many sandboxes were started, kept and carried
// into an account, how many identifications were served (barcode and vision,
// found and not found), how many scans and how many things were added.
//
// Read by GET /super-admin/usage-stats, which the ops console fetches from
// every surface with an ops:read token, and by the weekly summary. Counts
// only: nothing here names a workspace or a person.
//
// A window is [now - N days, now): an event exactly N days old counts, one a
// millisecond older does not. Day counters (product_daily_counts) are kept
// per UTC day, so their window is the N most recent days including today.
//
// The funnel's exclusions apply (platform/activation.ts): workspaces with a
// platform admin as a member (the founder's own use proves nothing about a
// stranger) and the CI test pool. Sandboxes are excluded from people and
// signups, and are the whole point of the sandbox counts.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { isPlatformAdmin } from "../auth/middleware.js";

export const USAGE_WINDOWS = [1, 7, 30] as const;
export type UsageWindow = `d${(typeof USAGE_WINDOWS)[number]}`;

export interface UsageCounts {
  signups: number;
  active_people: number;
  sandboxes_started: number;
  sandboxes_kept: number;
  sandboxes_moved_in: number;
  identifications: {
    barcode: { found: number; not_found: number };
    vision: { found: number; not_found: number };
  };
  scans: number;
  items_added: number;
}

export interface UsageStats {
  generated_at: string;
  windows: Record<UsageWindow, UsageCounts>;
}

const DAY_MS = 86_400_000;

/** Workspaces that never count: the founder's own, and the CI pool. */
async function excludedOrgs(): Promise<string[]> {
  const members = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.org_id", "u.email"])
    .execute();
  const out = new Set(members.filter((m) => isPlatformAdmin(m.email)).map((m) => m.org_id));
  for (const r of await meta.selectFrom("test_org_pool").select("org_id").execute()) out.add(r.org_id);
  return [...out];
}

function notIn(column: string, ids: string[]) {
  return ids.length ? sql`and ${sql.ref(column)} not in (${sql.join(ids.map((i) => sql`${i}::uuid`))})` : sql``;
}

async function eventCount(event: string, since: Date, until: Date, excluded: string[], opts: { people?: boolean; noSandboxes?: boolean } = {}): Promise<number> {
  const sandboxClause = opts.noSandboxes
    ? sql`and not exists (select 1 from orgs o where o.id = e.org_id and o.sandbox = true)`
    : sql``;
  const what = opts.people ? sql`count(distinct e.user_id)` : sql`count(*)`;
  const r = await sql<{ n: string }>`
    select ${what} as n from product_events e
     where e.event = ${event} and e.created_at >= ${since} and e.created_at < ${until}
       ${notIn("e.org_id", excluded)} ${sandboxClause}
  `.execute(meta);
  return Number(r.rows[0]?.n ?? 0);
}

// SANCTIONED-UTC-DAY: the counters are written per UTC day (product-events.ts
// utcDay) and summed for an operator report across every time zone, not to
// decide anything on a person's local day.
async function dayCount(metric: string, days: number, now: Date, excluded: string[]): Promise<number> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const first = new Date(today.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const r = await sql<{ n: string | null }>`
    select sum(c.n) as n from product_daily_counts c
     where c.metric = ${metric} and c.day >= ${first}::date and c.day <= ${today.toISOString().slice(0, 10)}::date
       ${notIn("c.org_id", excluded)}
  `.execute(meta);
  return Number(r.rows[0]?.n ?? 0);
}

async function itemsAdded(since: Date, until: Date, excluded: string[]): Promise<number> {
  const r = await sql<{ n: string }>`
    select count(*) as n from activity_log a
     where a.action = 'created' and a.occurred_at >= ${since} and a.occurred_at < ${until}
       ${notIn("a.org_id", excluded)}
       and not exists (select 1 from orgs o where o.id = a.org_id and o.sandbox = true)
  `.execute(meta);
  return Number(r.rows[0]?.n ?? 0);
}

/** This deployment's usage in each window, as of `now`. */
export async function usageStats(now: Date = new Date()): Promise<UsageStats> {
  const excluded = await excludedOrgs();
  const windows = {} as Record<UsageWindow, UsageCounts>;
  for (const days of USAGE_WINDOWS) {
    const since = new Date(now.getTime() - days * DAY_MS);
    const [signups, active, started, kept, moved, bHit, bMiss, vHit, vMiss, scans, items] = await Promise.all([
      eventCount("signed_up", since, now, excluded, { noSandboxes: true }),
      eventCount("active_day", since, now, excluded, { people: true, noSandboxes: true }),
      eventCount("sandbox_started", since, now, excluded),
      eventCount("sandbox_kept", since, now, excluded),
      eventCount("sandbox_carried_in", since, now, excluded),
      dayCount("identify.barcode.found", days, now, excluded),
      dayCount("identify.barcode.not_found", days, now, excluded),
      dayCount("identify.vision.found", days, now, excluded),
      dayCount("identify.vision.not_found", days, now, excluded),
      dayCount("scan.captured", days, now, excluded),
      itemsAdded(since, now, excluded),
    ]);
    windows[`d${days}` as UsageWindow] = {
      signups,
      active_people: active,
      sandboxes_started: started,
      sandboxes_kept: kept,
      sandboxes_moved_in: moved,
      identifications: { barcode: { found: bHit, not_found: bMiss }, vision: { found: vHit, not_found: vMiss } },
      scans,
      items_added: items,
    };
  }
  return { generated_at: now.toISOString(), windows };
}
