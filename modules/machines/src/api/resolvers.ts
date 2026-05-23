import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { MachinesDB } from "../db.js";

let registered = false;

export function registerMachinesResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("machines:machine", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
    const row = await db
      .selectFrom("machines_machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedMachine(row);
  });

  platform().entities.registerListResolver("machines:machine", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("machines_machines").selectAll();
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) => eb(eb.fn("lower", ["name"]), "like", needle));
    }
    if (query.filter) {
      const NATIVE = new Set(["state", "family", "type", "manufacturer", "location_id"]);
      for (const [key, val] of Object.entries(query.filter)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          const tagName = String(val).trim().toLowerCase();
          q = q.where(sql<boolean>`exists (
            select 1 from core_tags_assignments a
            join core_tags_tags t on t.id = a.tag_id
            where a.source_module = 'machines'
              and a.source_type = 'machine'
              and a.source_id = machines_machines.id
              and lower(t.name) = ${tagName}
          )`);
          continue;
        }
        if (NATIVE.has(key)) {
          if (typeof val === "string") q = q.where(key as never, "=", val as never);
          continue;
        }
        q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
      }
    }
    // D10: comparison predicates on numeric / date columns.
    if (query.where) {
      const COMPARABLE = new Set(["excitement", "quantity", "created_at", "updated_at"]);
      for (const p of query.where) {
        if (!COMPARABLE.has(p.col)) continue;
        if (!["<", "<=", ">", ">=", "=", "!="].includes(p.op)) continue;
        if (p.ref_col) {
          if (!COMPARABLE.has(p.ref_col)) continue;
          q = q.where(
            sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${sql.ref(p.ref_col)}`,
          );
        } else if (p.value !== undefined) {
          const v = p.value === "now" ? sql<unknown>`now()` : sql<unknown>`${p.value}`;
          q = q.where(sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${v}`);
        }
      }
    }
    const rows = await q.orderBy("name", "asc").limit(limit).offset(offset).execute();
    return { items: rows.map((r) => toResolvedMachine(r)) };
  });
}

function toResolvedMachine(row: {
  id: string;
  name: string;
  state: string;
  [k: string]: unknown;
}): ResolvedEntity {
  return {
    kind: "machines:machine",
    id: row.id,
    title: row.name,
    subtitle: row.state,
    detailUrl: `/machines/${row.id}`,
    fields: row as unknown as Record<string, unknown>,
  };
}
