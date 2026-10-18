// A bundle's view put back as the bundle made it. A bundle's view keeps the
// bundle's own copy beside the person's (bundle_base, migration 0004), so what a
// person changed is the difference and going back is putting the copy back.
// Whether the view is the default is left as it is: that is one choice per
// kind, not a part of how the view looks.
//
// Its own file because the route and the action both use it and the route's
// file is imported by the lookup the action reads through.
import type { Kysely } from "kysely";
import type { CoreViewsDB } from "../db.js";
import type { ViewRow } from "./view-lookup.js";

export interface ViewBefore {
  name: string;
  view_type: string;
  config: unknown;
  pinned: boolean;
}

/** The view as the bundle has it, or why it cannot be. */
export async function resetViewToBundle(
  db: Kysely<CoreViewsDB>,
  view: ViewRow,
): Promise<{ ok: true; row: ViewRow; before: ViewBefore; changed: boolean } | { ok: false; error: string }> {
  const base = view.bundle_base;
  if (!view.bundle_id || !base) return { ok: false, error: `"${view.name}" did not come with a bundle, so there is nothing to put it back to.` };
  const before: ViewBefore = { name: view.name, view_type: view.view_type, config: view.config, pinned: view.pinned };
  const back = { name: base.name, view_type: base.view_type, config: base.config, pinned: base.pinned };
  if (JSON.stringify(before) === JSON.stringify(back)) return { ok: true, row: view, before, changed: false };
  const row = await db
    .updateTable("core_views_views")
    .set({ ...back, updated_at: new Date() } as never)
    .where("id", "=", view.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { ok: true, row, before, changed: true };
}
