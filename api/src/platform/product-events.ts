// Product telemetry — the thesis metrics (2026-07 audit F2).
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
// Read side: GET /super-admin/product-metrics (routes/super-admin.ts) —
// per-org walls/week + TTFW derived from orgs.created_at → first
// activity_log 'created' row.

import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { meta } from "../db/meta.js";

export interface ProductEvent {
  orgId: string;
  userId?: string | null;
  /** e.g. "permission_denied" | "validation_rejected" | "wire_depth_exceeded" */
  event: string;
  detail?: Record<string, unknown>;
}

const RETENTION_DAYS = 180;

/** Best-effort insert — telemetry must never fail (or slow) the request that
 *  emitted it, so this is fire-and-forget with a swallowed error. ~1% of
 *  inserts also sweep rows past retention, so the table self-prunes without
 *  a scheduler (the audit's "activity_log grows forever" lesson, pre-applied). */
export function trackProductEvent(e: ProductEvent): void {
  void (async () => {
    try {
      await meta
        .insertInto("product_events")
        .values({
          org_id: e.orgId,
          user_id: e.userId ?? null,
          event: e.event,
          detail: e.detail ? sql`${JSON.stringify(e.detail)}::jsonb` : null,
        })
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
  })();
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
