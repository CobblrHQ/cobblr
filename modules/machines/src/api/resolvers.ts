import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { MachinesDB } from "../db.js";

let registered = false;

export function registerMachinesResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver(
    "machines:machine",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
      const row = await db
        .selectFrom("machines_machines")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      const resolved: ResolvedEntity = {
        kind: "machines:machine",
        id: row.id,
        title: row.name,
        subtitle: row.state,
        detailUrl: `/machines/${row.id}`,
        fields: row as unknown as Record<string, unknown>,
      };
      return resolved;
    },
  );
}
