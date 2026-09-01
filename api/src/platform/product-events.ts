// Product telemetry — the thesis metrics (2026-07 audit F2) and, since
// 2026-09, the activation funnel.
//
// The strategy docs' north star is walls-hit-per-week by a genuine non-dev,
// plus time-to-first-working-app — and neither was instrumented anywhere.
// This is the write side: a tiny best-effort tracker for HIGH-SIGNAL events
// (a wall someone hit, a rejection, an adoption milestone), and an Express
// observer that turns every org-scoped 403 into a `permission_denied` row —
// one choke point that covers kernel routes AND every module router without
// touching module isolation.
//
// Deliberately NOT the activity log (that's the mutation audit) and NOT the
// event bus (that's domain events wires fire on). Sparse by design: if an
// event wouldn't change what you'd build next week, don't track it.
//
// Two shapes of row:
//   - an OCCURRENCE (`trackProductEvent`): one row each time it happens.
//   - a DAILY FACT (`trackDailyProductEvent`): at most one row per workspace +
//     user + event + UTC day. `active_day` ("this person used this workspace
//     today") and `scan_captured` ("they scanned something today") are daily,
//     because the funnel asks WHETHER they came back, not how many requests
//     they made. A Live Sort session firing 300 captures is one fact.
//
// Read side: GET /super-admin/product-metrics (routes/super-admin.ts) —
// per-org walls/week, TTFW derived from orgs.created_at → first activity_log
// 'created' row, and the activation cohort (platform/activation.ts).

import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { meta } from "../db/meta.js";

export interface ProductEvent {
  orgId: string;
  userId?: string | null;
  /** e.g. "permission_denied" | "validation_rejected" | "scan_captured" */
  event: string;
  detail?: Record<string, unknown>;
}

const RETENTION_DAYS = 180;

/** Best-effort insert — telemetry must never fail (or slow) the request that
 *  emitted it, so this is fire-and-forget with a swallowed error. ~1% of
 *  inserts also sweep rows past retention, so the table self-prunes without
 *  a scheduler (the audit's "activity_log grows forever" lesson, pre-applied). */
export function trackProductEvent(e: ProductEvent): void {
  void insertEvent(e, null);
}

/** The UTC calendar day, the way the daily unique index spells it. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Daily facts are written once per process per (org, user, event, day); the
// partial unique index (migration 117) is the cross-process backstop. Bounded:
// a busy host clears the set rather than growing it forever.
const dailySeen = new Set<string>();
const DAILY_SEEN_CAP = 20_000;

/** One row per workspace + user + event + UTC day. Same best-effort contract as
 *  `trackProductEvent`; a second call the same day is a no-op before it
 *  reaches Postgres, and `on conflict do nothing` absorbs the race across api
 *  processes. */
export function trackDailyProductEvent(e: ProductEvent): void {
  const day = utcDay();
  const key = `${e.orgId}|${e.userId ?? ""}|${e.event}|${day}`;
  if (dailySeen.has(key)) return;
  if (dailySeen.size >= DAILY_SEEN_CAP) dailySeen.clear();
  dailySeen.add(key);
  void insertEvent(e, day);
}

/** The retention fact: this person touched this workspace today. Called from
 *  the tenant middleware on every session-authenticated org request; the
 *  daily dedupe makes that free after the first call of the day. */
export function noteActiveDay(orgId: string, userId: string): void {
  trackDailyProductEvent({ orgId, userId, event: "active_day" });
}

async function insertEvent(e: ProductEvent, day: string | null): Promise<void> {
  try {
    await meta
      .insertInto("product_events")
      .values({
        org_id: e.orgId,
        user_id: e.userId ?? null,
        event: e.event,
        detail: e.detail ? sql`${JSON.stringify(e.detail)}::jsonb` : null,
        day,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    if (Math.random() < 0.01) {
      await meta
        .deleteFrom("product_events")
        .where("created_at", "<", sql<Date>`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`)
        .execute();
    }
  } catch (err) {
    console.error("[product-events] insert failed:", (err as Error).message);
  }
}

/** Express observer: any org-scoped response that finishes 403 is a WALL —
 *  someone tried to do something their role/grants don't allow. Mount once,
 *  early (after tenant middleware is irrelevant — req.tenant is read at
 *  finish time, by which point withTenant has run for org routes). Skips
 *  non-tenant 403s (login throttles, app-token clamps carry no org ctx). */
export function productEventsObserver(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    if (res.statusCode !== 403) return;
    const tenant = req.tenant;
    if (!tenant?.org?.id) return;
    trackProductEvent({
      orgId: tenant.org.id,
      userId: req.session?.id ?? null,
      event: "permission_denied",
      detail: {
        method: req.method,
        // Path without query (querystrings can carry junk/PII).
        path: (req.originalUrl ?? req.url).split("?")[0],
        role: tenant.role,
      },
    });
  });
  next();
}
