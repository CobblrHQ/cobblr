import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { AssetsDB } from "../db.js";

let registered = false;

export function registerAssetsResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("assets:asset", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    const row = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    const resolved: ResolvedEntity = {
      kind: "assets:asset",
      id: row.id,
      title: row.name,
      subtitle: row.state,
      fields: row as unknown as Record<string, unknown>,
    };
    return resolved;
  });
}
