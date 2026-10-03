import { sql } from "kysely";
import { platform, type EntityRef, type DeletionSnapshot } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { baseKindOf } from "./entities.js";

function refsIn(ref: EntityRef, snapshot?: DeletionSnapshot): EntityRef[] {
  const rows = (snapshot?.related as { rows?: Array<{ table: string; row: { id?: string } }> } | undefined)?.rows ?? [];
  return [ref, ...rows.flatMap((r) => {
    if (!r.row.id) return [];
    const module = ref.kind.split(":")[0]!;
    const name = r.table.replace(`${module.replace(/-/g, "_")}_`, "").replace(/s$/, "");
    return [{ kind: `${module}:${name}`, id: r.row.id }];
  })];
}

export function registerDeletedRelations(): void {
  platform().deletedRecords.registerParticipant("platform.placements", {
    snapshot: async (orgId, ref, snapshot) => {
      const refs = refsIn({ ...ref, kind: await baseKindOf(orgId, ref.kind) }, snapshot);
      const out: Array<{ containee: EntityRef; container: EntityRef; slot: string | null; position?: unknown }> = [];
      for (const r of refs) {
        const inPlace = await platform().placement.containerOf({ orgId, containee: r });
        if (inPlace) {
          const placement = (await platform().placement.contents({ orgId, container: inPlace })).find((c) => c.id === r.id && c.kind === r.kind);
          out.push({ containee: r, container: inPlace, slot: placement?.slot ?? null, position: placement?.position });
        }
        for (const child of await platform().placement.contents({ orgId, container: r })) out.push({ containee: { kind: child.kind, id: child.id }, container: r, slot: child.slot ?? null, position: child.position });
      }
      return out;
    },
    purge: async (orgId, _ref, image) => {
      for (const row of image as Array<{ containee: EntityRef; container: EntityRef }>) {
        const current = await platform().placement.containerOf({ orgId, containee: row.containee });
        if (current?.kind === row.container.kind && current.id === row.container.id) await platform().placement.remove({ orgId, containee: row.containee });
      }
    },
    restore: async (orgId, _ref, image) => {
      for (const row of image as Array<{ containee: EntityRef; container: EntityRef; slot: string | null; position?: unknown }>) {
        if (await platform().placement.containerOf({ orgId, containee: row.containee })) continue;
        if (!await platform().entities.lookup(orgId, row.container.kind, row.container.id) || !await platform().entities.lookup(orgId, row.containee.kind, row.containee.id)) continue;
        await platform().placement.place({ orgId, ...row, position: row.position as never });
      }
    },
  });
  platform().deletedRecords.registerParticipant("platform.links", {
    snapshot: async (orgId, ref, snapshot) => {
      const refs = refsIn(ref, snapshot);
      const ids = refs.map((r) => r.id);
      return (await sql<Record<string, unknown>>`select * from entity_pairings where org_id = ${orgId}
        and (source_id in (${sql.join(ids)}) or target_id in (${sql.join(ids)}))`.execute(meta)).rows;
    },
    purge: async (orgId, _ref, image) => {
      for (const row of image as Array<Record<string, unknown>>) await sql`delete from entity_pairings where org_id = ${orgId} and id = ${row.id}`.execute(meta);
    },
    restore: async (orgId, _ref, image) => {
      for (const row of image as Array<Record<string, unknown>>) {
        const columns = Object.keys(row);
        await sql`insert into entity_pairings (${sql.join(columns.map((c) => sql.ref(c)))})
          values (${sql.join(columns.map((c) => c === "org_id" ? orgId : typeof row[c] === "object" && row[c] !== null ? JSON.stringify(row[c]) : row[c]))}) on conflict do nothing`.execute(meta);
      }
    },
  });
}
