// The saved view a person named, among the ones they can see: shared with the
// workspace, or their own. Shared by edit-view and delete-view so neither can
// reach someone else's private view.
import type { Kysely, Selectable } from "kysely";
import type { CoreViewsDB, ViewsTable } from "../db.js";
import { visibleTo } from "./views.js";

export type ViewRow = Selectable<ViewsTable>;

export async function findVisibleView(db: Kysely<CoreViewsDB>, userId: string | null, named: string): Promise<ViewRow | { error: string }> {
  const want = named.trim();
  if (!want) return { error: "Say which view." };
  const rows = await db.selectFrom("core_views_views").selectAll().where(visibleTo(userId)).execute();
  const byId = rows.find((r) => r.id === want);
  if (byId) return byId;
  const byName = rows.filter((r) => r.name.toLowerCase() === want.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) return { error: `More than one view is called "${want}". Say which kind of record it shows.` };
  return { error: rows.length ? `No view called "${want}". There is ${rows.map((r) => r.name).join(", ")}.` : "There are no saved views yet." };
}
