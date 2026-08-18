// core-catalogs action handlers.
//
// This module had NO actions at all, so refreshing a catalog from its source
// was reachable only by clicking. "Pull the latest price list" is a plain
// request, and the assistant could only say it had no way.
//
// Only /pull gets a door. /sync is a stub that always answers "no puller" (the
// pullable-catalog work is unshipped), and /import-csv needs an uploaded file,
// which an action cannot carry. Giving either one a door would advertise a
// capability that cannot be served, which is the failure this whole audit is
// about.

import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { pullCatalogFromSource } from "./catalogs.js";
import type { CoreCatalogsDB } from "../db.js";

export function registerCatalogsHandlers(): void {
  platform().actions.registerHandler("core-catalogs.refresh", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreCatalogsDB>;
    const catalog = await db
      .selectFrom("core_catalogs_catalogs")
      .selectAll()
      .where("id", "=", entity.id)
      .executeTakeFirst();
    if (!catalog) return { ok: false, error: "that catalog no longer exists" };

    const url = (catalog.source_url as string | null) ?? null;
    if (!url) {
      return {
        ok: false,
        error:
          "This catalog has no source URL to refresh from. It was built by importing a CSV, so re-import to update it.",
      };
    }

    const outcome = await pullCatalogFromSource(db as never, ctx.orgId, catalog as never, url);
    if (!outcome.ok) return { ok: false, error: outcome.message };
    return {
      ok: true,
      result: {
        imported: outcome.imported,
        total: outcome.total,
        note: `Refreshed from the source: ${outcome.imported} of ${outcome.total} row(s) imported.`,
      },
    };
  });
}
