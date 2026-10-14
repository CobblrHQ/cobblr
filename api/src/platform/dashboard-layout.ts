// The admin dashboard's arrangement: the order, visibility and width of its
// cards (widgets, owned by the web registry and named by its module or own
// id) and the order and visibility of its sections. One read and one save for
// the dashboard (routes/dashboard.ts) and platform:arrange-dashboard (#6528).

import { z } from "zod";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import * as activity from "./activity.js";

export const DashboardLayoutShape = z.object({
  widgets: z
    .array(
      z.object({
        // Opaque to the server — owned by the web registry. Bounded so a
        // bad client can't store unbounded ids.
        id: z.string().min(1).max(120),
        hidden: z.boolean().default(false),
        // Tile width in grid columns (1 = normal, 2 = wide). Bounded.
        span: z.number().int().min(1).max(2).optional(),
      }),
    )
    .max(200)
    .default([]),
  // Order + visibility of the whole dashboard sections (at_a_glance /
  // pinned_views / recent_activity). Optional — absent = default order.
  sections: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        hidden: z.boolean().default(false),
      }),
    )
    .max(50)
    .optional(),
});
export type DashboardLayout = z.infer<typeof DashboardLayoutShape>;

export async function readDashboardLayout(orgId: string): Promise<DashboardLayout> {
  const row = await meta.selectFrom("orgs").select(["dashboard_layout"]).where("id", "=", orgId).executeTakeFirst();
  const parsed = DashboardLayoutShape.safeParse(row?.dashboard_layout ?? { widgets: [] });
  return parsed.success ? parsed.data : { widgets: [] };
}

export async function saveDashboardLayout(orgId: string, userId: string | null, layout: DashboardLayout): Promise<void> {
  await meta
    .updateTable("orgs")
    .set({
      // jsonb-replace-ok: the whole layout is saved at once; there is no other writer to preserve
      dashboard_layout: sql`${JSON.stringify(layout)}::jsonb` as never,
      updated_at: new Date(),
    })
    .where("id", "=", orgId)
    .execute();
  await activity.log({
    orgId,
    userId,
    action: "dashboard_layout_updated",
    // history-before-ok: a workspace setting, logged as counts; no record's fields changed.
    ref: { module: null, entityType: "org", entityId: orgId },
    diff: { widgets: layout.widgets.length, hidden: layout.widgets.filter((w) => w.hidden).length },
  });
}
