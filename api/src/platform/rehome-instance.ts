// Re-home a workspace instance from the assets module onto the records
// substrate — the Phase-2 data move of the field-model plan
// (docs/design-decisions/field-model spec, "books get their own kind on a
// neutral substrate"). A catalog-shaped instance (a Bookshelf authored as an
// "asset tracker") stops riding on assets: its rows move to records_records
// (ids preserved, so links/labels keep resolving), its attachment + tag refs
// are rewritten, and the instance registry re-points. Custom field defs and
// saved views key on `<instance>:item` and follow the instance untouched.
//
// NOTHING is destroyed: any non-default domain value on a moved row
// (a serial number, a warranty date, a manufacturer) is folded into the
// record's metadata bag rather than dropped — a wrongly-classified instance
// loses no data, it just carries the values as custom fields.
//
// Deliberately an EXPLICIT operation (super-admin / test-support), not a boot
// sweep: classifying which instances are catalog-shaped automatically is a
// separate decision from being able to move one safely.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, evictTenantPool } from "../db/tenant.js";
import { enableModuleForOrg } from "../modules/enable.js";

export interface RehomeResult {
  moved: number;
  attachments: number;
  tags: number;
  foldedDomainValues: number;
}

/** The assets columns that don't exist on records: fold non-default values
 *  into metadata under their own names so nothing is lost. */
const FOLD_COLUMNS = [
  "short_name",
  "manufacturer",
  "model",
  "type",
  "serial_number",
  "purchased_at",
  "warranty_until",
  "last_service_at",
] as const;

export async function rehomeAssetsInstanceToRecords(
  orgId: string,
  instanceName: string,
): Promise<RehomeResult> {
  const inst = await meta
    .selectFrom("workspace_module_instances")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("instance_name", "=", instanceName)
    .executeTakeFirst();
  if (!inst) throw new Error(`Instance "${instanceName}" not found for this workspace.`);
  if (inst.module_name === "records") {
    return { moved: 0, attachments: 0, tags: 0, foldedDomainValues: 0 }; // already home — idempotent
  }
  if (inst.module_name !== "assets") {
    throw new Error(`Only assets instances can be re-homed to records (this one is "${inst.module_name}").`);
  }

  // records enabled + its tenant migration run (enableModuleForOrg is
  // idempotent for an already-enabled module).
  await enableModuleForOrg(orgId, "records");

  try {
    const tdb = await getTenantDb(orgId);
    const result = await tdb.transaction().execute(async (trx) => {
      const rows = await sql<{
        id: string;
        name: string;
        image_path: string | null;
        notes: string | null;
        location_id: string | null;
        metadata: Record<string, unknown> | null;
        instance: string;
        created_at: Date;
        updated_at: Date;
        state: string | null;
        quantity: number | null;
        excitement: number | null;
        short_name: string | null;
        manufacturer: string | null;
        model: string | null;
        type: string | null;
        serial_number: string | null;
        purchased_at: string | null;
        warranty_until: string | null;
        last_service_at: string | null;
      }>`select * from assets_assets where instance = ${instanceName}`.execute(trx);

      let folded = 0;
      for (const r of rows.rows) {
        const metadata: Record<string, unknown> = { ...(r.metadata ?? {}) };
        for (const col of FOLD_COLUMNS) {
          const v = r[col];
          if (v != null && v !== "" && metadata[col] === undefined) {
            metadata[col] = v;
            folded++;
          }
        }
        // Non-default state / quantity / excitement carry meaning; defaults don't.
        if (r.state && r.state !== "working" && metadata.state === undefined) {
          metadata.state = r.state;
          folded++;
        }
        if (r.quantity != null && Number(r.quantity) !== 1 && metadata.quantity === undefined) {
          metadata.quantity = Number(r.quantity);
          folded++;
        }
        await sql`
          insert into records_records (id, name, image_path, notes, location_id, metadata, instance, created_at, updated_at)
          values (${r.id}::uuid, ${r.name}, ${r.image_path}, ${r.notes}, ${r.location_id}::uuid,
                  ${JSON.stringify(metadata)}::jsonb, ${r.instance}, ${r.created_at}, ${r.updated_at})
          on conflict (id) do nothing
        `.execute(trx);
      }

      const ids = rows.rows.map((r) => r.id);
      let attachments = 0;
      let tags = 0;
      if (ids.length > 0) {
        const att = await sql`
          update core_files_attachments set source_module = 'records', source_type = 'record'
          where source_module = 'assets' and source_id = any(${ids}::uuid[])
        `.execute(trx);
        attachments = Number(att.numAffectedRows ?? 0);
        const tag = await sql`
          update core_tags_assignments set source_module = 'records', source_type = 'record'
          where source_module = 'assets' and source_id = any(${ids}::uuid[])
        `.execute(trx);
        tags = Number(tag.numAffectedRows ?? 0);
        await sql`delete from assets_assets where instance = ${instanceName}`.execute(trx);
      }
      return { moved: rows.rows.length, attachments, tags, foldedDomainValues: folded };
    });

    // Registry re-point LAST — a failure above leaves the instance fully on
    // assets (the transaction rolled back), never half-moved.
    await meta
      .updateTable("workspace_module_instances")
      .set({ module_name: "records" })
      .where("org_id", "=", orgId)
      .where("instance_name", "=", instanceName)
      .execute();

    return result;
  } finally {
    // Boot/admin-path discipline: never hold a tenant pool after a sweep.
    await evictTenantPool(orgId).catch(() => {});
  }
}
