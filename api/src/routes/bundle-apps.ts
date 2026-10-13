import { isDeepStrictEqual } from "node:util";
import { sql, type Generated, type Kysely } from "kysely";
import { resolveAppViewRefs, type SeededView } from "./bundle-app-view-refs.js";

export interface BundleApp {
  slug: string;
  name: string;
  icon?: string | null;
  visible_capability?: string | null;
  pages: unknown[];
  theme?: unknown;
}

export interface BundleAppRow {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  visible_capability: string | null;
  pages: unknown;
  theme: unknown;
  created_by: string | null;
}

export interface BundleAppsDB { core_apps_apps: Omit<BundleAppRow, "id"> & { id: Generated<string> } }
const definition = (app: BundleApp | BundleAppRow) => ({
  slug: app.slug, name: app.name, icon: app.icon ?? null,
  visible_capability: app.visible_capability ?? null, pages: app.pages, theme: app.theme ?? null,
});

export function appsFromManifest(raw: unknown, enabledFeatures: readonly string[]): BundleApp[] {
  const m = (typeof raw === "string" ? JSON.parse(raw) : raw) as { provides_apps?: BundleApp[]; features?: Array<{ key: string; provides_apps?: BundleApp[] }> } | null;
  return [...(m?.provides_apps ?? []), ...(m?.features ?? []).filter((f) => enabledFeatures.includes(f.key)).flatMap((f) => f.provides_apps ?? [])];
}

export function planBundleAppUpdates(rows: BundleAppRow[], incoming: BundleApp[], previous: BundleApp[]) {
  const updates: Array<{ id: string; from: ReturnType<typeof definition>; to: ReturnType<typeof definition> }> = [];
  for (const app of incoming) {
    const row = rows.find((r) => r.slug === app.slug);
    if (!row || row.created_by !== null) continue;
    const baseline = previous.find((p) => p.slug === row.slug && isDeepStrictEqual(p.pages, row.pages));
    if (!baseline) continue;
    const from = definition(row);
    const was = definition(baseline);
    const next = definition(app);
    const to = { ...from };
    for (const key of ["name", "icon", "visible_capability", "pages", "theme"] as const) {
      if (isDeepStrictEqual(from[key], was[key])) Object.assign(to, { [key]: next[key] });
    }
    if (!isDeepStrictEqual(from, to)) updates.push({ id: row.id, from, to });
  }
  return updates;
}

export async function syncBundleApps(db: Kysely<BundleAppsDB>, apps: BundleApp[], previous: BundleApp[], views: SeededView[], createMissing = true): Promise<number> {
  let updated = 0;
  for (const app of apps) {
    const { pages, unresolved } = resolveAppViewRefs(app.pages, views);
    if (unresolved.length) throw new Error(`App ${app.slug} references unknown saved views: ${unresolved.join(", ")}`);
    const incoming = { ...app, pages };
    const row = await db.selectFrom("core_apps_apps").selectAll().where("slug", "=", app.slug).executeTakeFirst();
    if (!row) {
      if (createMissing) await db.insertInto("core_apps_apps").values({
        ...definition(incoming), pages: sql`${JSON.stringify(pages)}::jsonb`,
        theme: incoming.theme ? sql`${JSON.stringify(incoming.theme)}::jsonb` : null, created_by: null,
      }).onConflict((oc) => oc.column("slug").doNothing()).execute();
      continue;
    }
    const update = planBundleAppUpdates([row], [incoming], previous)[0];
    if (!update) continue;
    const { from, to } = update;
    const fromTheme = from.theme === null ? sql`null` : sql`${JSON.stringify(from.theme)}::jsonb`;
    const toTheme = to.theme === null ? sql`null` : sql`${JSON.stringify(to.theme)}::jsonb`;
    // Compare the whole definition in the write: an edit during the read keeps its fields.
    const result = await sql`
      update core_apps_apps set name = ${to.name}, icon = ${to.icon}, visible_capability = ${to.visible_capability},
        pages = ${JSON.stringify(to.pages)}::jsonb, theme = ${toTheme}, updated_at = now()
      where id = ${row.id} and created_by is null and slug = ${from.slug} and name = ${from.name}
        and icon is not distinct from ${from.icon} and visible_capability is not distinct from ${from.visible_capability}
        and pages = ${JSON.stringify(from.pages)}::jsonb and theme is not distinct from ${fromTheme}`.execute(db);
    updated += Number(result.numAffectedRows ?? 0);
  }
  return updated;
}
