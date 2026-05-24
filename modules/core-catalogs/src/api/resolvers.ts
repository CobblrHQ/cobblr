// Entity-kind resolvers for core-catalogs.
//   core-catalogs:catalog → the imported dataset itself
//   core-catalogs:entry   → one row inside a catalog
//
// Both kinds are tenant-DB-owned. Title / subtitle / image_path on
// entries come from the parent catalog's schema config — the
// resolver pulls from payload[title_column / image_column /
// subtitle_column] for each entry at lookup time.

import { sql, type Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { CoreCatalogsDB } from "../db.js";

let registered = false;

export function registerCatalogsResolvers(): void {
  if (registered) return;
  registered = true;

  // ───────────────────────── catalog ───────────────────────────────
  platform().entities.registerResolver(
    "core-catalogs:catalog",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreCatalogsDB>;
      const row = await db
        .selectFrom("core_catalogs_catalogs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return toCatalog(row);
    },
  );

  platform().entities.registerListResolver(
    "core-catalogs:catalog",
    async (orgId, query) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreCatalogsDB>;
      const limit = Math.min(query.limit ?? 50, 200);
      const offset = query.offset ?? 0;
      let q = db.selectFrom("core_catalogs_catalogs").selectAll();
      if (query.q && query.q.length > 0) {
        const needle = `%${query.q.toLowerCase()}%`;
        q = q.where((eb) =>
          eb.or([
            eb(eb.fn("lower", ["name"]), "like", needle),
            eb(eb.fn("lower", ["description"]), "like", needle),
          ]),
        );
      }
      const rows = await q.orderBy("name").limit(limit).offset(offset).execute();
      return { items: rows.map((r) => toCatalog(r)) };
    },
  );

  // ─────────────────────────── entry ───────────────────────────────
  platform().entities.registerResolver(
    "core-catalogs:entry",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreCatalogsDB>;
      const row = await db
        .selectFrom("core_catalogs_entries as e")
        .innerJoin("core_catalogs_catalogs as c", "c.id", "e.catalog_id")
        .select([
          "e.id",
          "e.catalog_id",
          "e.external_id",
          "e.payload",
          "c.name as catalog_name",
          "c.schema as catalog_schema",
        ])
        .where("e.id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return toEntry(row);
    },
  );

  platform().entities.registerListResolver(
    "core-catalogs:entry",
    async (orgId, query) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreCatalogsDB>;
      const limit = Math.min(query.limit ?? 50, 200);
      const offset = query.offset ?? 0;
      // Filter by catalog_id if requested; the match picker uses this.
      let q = db
        .selectFrom("core_catalogs_entries as e")
        .innerJoin("core_catalogs_catalogs as c", "c.id", "e.catalog_id")
        .select([
          "e.id",
          "e.catalog_id",
          "e.external_id",
          "e.payload",
          "c.name as catalog_name",
          "c.schema as catalog_schema",
        ]);
      const filter = query.filter ?? {};
      if (typeof filter.catalog_id === "string") {
        q = q.where("e.catalog_id", "=", filter.catalog_id);
      }
      if (query.q && query.q.length > 0) {
        const needle = `%${query.q.toLowerCase()}%`;
        // Searches the conventional `name` payload column. Catalogs
        // whose title column differs still match if their column
        // happens to be named `name` in the source — most do; a
        // catalog with a different title column gets prefix-only
        // matching via the title_column index at the route layer.
        q = q.where(
          sql<boolean>`lower(e.payload->>'name') like ${needle}`,
        );
      }
      const rows = await q.limit(limit).offset(offset).execute();
      return { items: rows.map((r) => toEntry(r)) };
    },
  );
}

function toCatalog(row: {
  id: string;
  name: string;
  description: string | null;
  source_url: string | null;
  puller_id: string | null;
  entry_count: number;
  schema: unknown;
}): ResolvedEntity {
  return {
    kind: "core-catalogs:catalog",
    id: row.id,
    title: row.name,
    subtitle: row.puller_id ?? undefined,
    detailUrl: `/configuration/catalogs/${row.id}`,
    fields: {
      name: row.name,
      description: row.description,
      source_url: row.source_url,
      puller_id: row.puller_id,
      entry_count: row.entry_count,
    },
  };
}

interface EntryJoinedRow {
  id: string;
  catalog_id: string;
  external_id: string;
  payload: unknown;
  catalog_name: string;
  catalog_schema: unknown;
}

function toEntry(row: EntryJoinedRow): ResolvedEntity {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const schema = (row.catalog_schema ?? {}) as Record<string, unknown>;
  const titleColumn = String(schema.title_column ?? "name");
  const imageColumn = String(schema.image_column ?? "image_url");
  const subtitleColumn = String(schema.subtitle_column ?? "");
  const descriptionColumn = String(schema.description_column ?? "");

  const title = String(payload[titleColumn] ?? row.external_id);
  const image =
    imageColumn && payload[imageColumn] !== undefined
      ? String(payload[imageColumn])
      : undefined;
  const subtitle =
    subtitleColumn && payload[subtitleColumn] !== undefined
      ? String(payload[subtitleColumn])
      : `${row.catalog_name} #${row.external_id}`;
  const description =
    descriptionColumn && payload[descriptionColumn] !== undefined
      ? String(payload[descriptionColumn])
      : undefined;

  return {
    kind: "core-catalogs:entry",
    id: row.id,
    title,
    subtitle,
    image_path: image,
    fields: {
      name: title,
      description,
      image_url: image,
      external_id: row.external_id,
      catalog_id: row.catalog_id,
    },
  };
}
