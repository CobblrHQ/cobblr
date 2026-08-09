import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { assetsRouter } from "./assets.js";
import { registerAssetsResolvers } from "./resolvers.js";
import { registerActionHandlers } from "./action-handlers.js";
import { registerAssetsWriter } from "./sync-writer.js";

registerAssetsResolvers();
registerActionHandlers();
registerAssetsWriter(); // silent cross-module writer (core-mobility et al.)
// Declare assets:asset as a scan target. (Audit 2026-06-26 follow-up — was a
// hardcoded entry in core-scan's SCANNABLE/endpoint/qty maps.)
platform().entities.registerScannable("assets:asset", {
  noun: "asset",
  createEndpoint: "assets/assets",
  qtyField: "quantity",
});
// Date custom-fields on assets:asset (renewal/return-by/warranty-expiry, …)
// land on the workspace calendar via the generic kernel source. (Audit
// 2026-06-26 follow-up — was a hardcoded kernel SPECS entry.)
platform().calendar.registerDateFieldSource({
  kind: "assets:asset",
  table: "assets_assets",
  entityModule: "assets",
  entityType: "asset",
});

// Per-instance item count — lets the nav hide an empty auto-created default
// instance once the workspace has named ones.
platform().instances.registerItemCounter("assets", async (orgId, instance) => {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
  const r = await sql<{ c: number }>`select count(*)::int as c from assets_assets where instance = ${instance}`.execute(db);
  return r.rows[0]?.c ?? 0;
});

// Same one-column move as inventory. See the note there and
// docs/design-decisions/move-between-instances.md.
platform().instances.registerMover("assets", {
  kindFor: (instance) => (instance === "assets" ? "assets:asset" : `${instance}:item`),
  async metadataFor(orgId, ids) {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
    const r = await sql<{ metadata: Record<string, unknown> | null }>`
      select metadata from assets_assets where id::text in (${sql.join(ids.map((i) => sql`${i}`))})
    `.execute(db);
    return r.rows.map((x) => x.metadata ?? {});
  },
  async move(_orgId, ids, from, to, db) {
    const trx = db as Kysely<unknown>;
    // `in (from, to)` rather than `= from`, so this is IDEMPOTENT. If the
    // platform's second (meta) transaction failed after this one committed,
    // the records are already in `to` and a re-run must still return them:
    // otherwise it reports nothing to do and the meta-side references stay on
    // the old kind forever. Rows already in `to` update to themselves.
    const r = await sql<{ id: string }>`
      update assets_assets set instance = ${to},
             updated_at = case when instance = ${to} then updated_at else now() end
       where instance in (${from}, ${to})
         and id::text in (${sql.join(ids.map((i) => sql`${i}`))})
       returning id
    `.execute(trx);
    return r.rows.map((x) => x.id);
  },
});

const router = Router({ mergeParams: true });
router.use("/assets", assetsRouter);

export default router;

// Primary-entity router for instance-scoped item CRUD — the platform
// dispatches /orgs/:slug/instances/:name/items here with req.instance set.
export { assetsRouter as primaryRouter };
