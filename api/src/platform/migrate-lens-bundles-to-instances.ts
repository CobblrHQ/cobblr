// HISTORICAL DATA MIGRATION — not kernel logic.
//
// Second-generation lens cleanup. `migrate-lens-modules.ts` turned the legacy
// lens MODULES (3d-printers, laser-cutters, cnc-machines) into lens BUNDLES
// (manifest.provides_lens, v0.1.0). A lens is a *filtered view of the shared
// machines table* — that's the "I removed the bundle and it still says
// Machines everywhere" state. The machine specialisations are now first-class
// INSTANCES of the multi-instance `machines` module (manifest.provides_instances,
// v0.3.0): their own clean /<name> tab, items still `machines:machine` rows so
// digifab / fleet / maintenance keep working.
//
// This pass converts every still-lens-shaped install of those three bundles
// into the instance shape automatically — NO user action. (the author, emphatic: we
// never tell a user "we changed our code, so uninstall something to fix it";
// a shape change must self-heal the existing install.)
//
//   META side:
//     1. provision the workspace_module_instances row (the nav tab),
//     2. seed the instance's nav override (item_noun + glyph),
//     3. re-key the bundle's field defs  machines:machine → <name>:item
//        (that's where the instance UI + the install path read them),
//     4. enable digifab + record it as an enabled feature (the bundle now
//        ships a default-on "Connect to your machines" capability),
//     5. rewrite the bundle row's manifest to the instance shape + bump to
//        0.3.0 so the dashboard stops offering a "downgrade" and this pass
//        terminates (orgsTouched=0) once every org is past it.
//   TENANT side:
//     6. move the specialisation's existing machines INTO the instance
//        (machines_machines.instance: 'machines' → '<name>') so they appear
//        under the new tab instead of stranded on /machines. "Belongs to the
//        lens" = exactly what the lens showed: metadata.specialisation matches
//        OR any of the specialisation's fields is populated.
//
// Idempotent: a bundle whose manifest already has provides_instances is
// skipped; createInstance is guarded by getInstance; the field-def re-key and
// the machine backfill both filter on the OLD value, so a second run is a
// no-op. Skip entirely with COBBLR_SKIP_HISTORICAL_MIGRATIONS=1. After every
// production org reads orgsTouched=0 consistently, this file can be deleted.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, evictTenantPool } from "../db/tenant.js";
import { createInstance, getInstance } from "./instances.js";
import { upsertOverride } from "./entity-kind-overrides.js";
import { enableModuleForOrg } from "../modules/enable.js";

/** The three machine-specialisation bundles + the presentation bits a lens
 *  manifest doesn't carry (item noun / glyph). Keyed by external_id. */
const INSTANCE_META: Record<string, { instanceName: string; noun: string; glyph: string }> = {
  "cobblr.community.3d-printers": { instanceName: "3d-printers", noun: "3D printer", glyph: "🖨️" },
  "cobblr.community.laser-cutters": { instanceName: "laser-cutters", noun: "laser cutter", glyph: "🔥" },
  "cobblr.community.cnc-machines": { instanceName: "cnc-machines", noun: "CNC machine", glyph: "⚙️" },
};

interface LensFieldDef {
  entity_kind?: string;
  name: string;
  [k: string]: unknown;
}
interface StoredManifest {
  provides_lens?: { entity_kind: string; name: string; display_name: string };
  provides_instances?: unknown[];
  field_defs?: LensFieldDef[];
  [k: string]: unknown;
}

function parseManifest(raw: unknown): StoredManifest | null {
  if (!raw) return null;
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as StoredManifest;
  } catch {
    return null;
  }
}

/** Convert one (org, lens-bundle) to the instance shape. Idempotent. Returns
 *  whether it actually did anything + how many machines it moved. */
async function migrateOne(
  orgId: string,
  bundleId: string,
  externalId: string,
  manifest: StoredManifest,
): Promise<{ migrated: boolean; machinesMoved: number }> {
  const info = INSTANCE_META[externalId];
  if (!info) return { migrated: false, machinesMoved: 0 };
  // Already the instance shape? Nothing to do.
  if (Array.isArray(manifest.provides_instances) && manifest.provides_instances.length > 0) {
    return { migrated: false, machinesMoved: 0 };
  }
  // Only act on the old lens shape.
  const lens = manifest.provides_lens;
  if (!lens) return { migrated: false, machinesMoved: 0 };

  const instanceName = info.instanceName;
  const displayName = lens.display_name || instanceName;
  const fieldNames = (manifest.field_defs ?? []).map((f) => f.name).filter(Boolean);

  // 1. Provision the instance (nav tab). Guarded — a prior partial run or a
  //    manual create won't duplicate.
  const existingInst = await getInstance(orgId, instanceName);
  if (!existingInst) {
    await createInstance({
      orgId,
      moduleName: "machines",
      instanceName,
      displayName,
      isDefault: false,
    });
  }
  // 2. Nav override (label + glyph + item noun). insertOnly so a user's own
  //    rename is preserved on a re-run.
  await upsertOverride({
    orgId,
    targetKind: "instance",
    targetId: `machines:${instanceName}`,
    displayLabel: displayName,
    icon: info.glyph,
    config: { item_noun: info.noun, qty_unit: null, parent: null },
    insertOnly: true,
  });

  // 3. Re-key the bundle's field defs to where the instance UI reads them.
  await meta
    .updateTable("module_field_defs")
    .set({ entity_kind: `${instanceName}:item` })
    .where("org_id", "=", orgId)
    .where("bundle_id", "=", bundleId)
    .where("entity_kind", "=", "machines:machine")
    .execute();

  // 4. Enable digifab (the bundle now ships it default-on) + record the
  //    feature so the bundle's enabled_features reflects it.
  try {
    await enableModuleForOrg(orgId, "digifab");
  } catch (err) {
    console.error(`[migrate-lens-bundles] enable digifab for org ${orgId} failed:`, (err as Error).message);
  }

  // 5. Rewrite the bundle row to the instance manifest + bump version so the
  //    dashboard stops flagging an "update" and this pass terminates.
  const newManifest: StoredManifest = { ...manifest, version: "0.3.0" };
  delete newManifest.provides_lens;
  newManifest.provides_instances = [
    {
      module: "machines",
      instance_name: instanceName,
      display_name: displayName,
      item_noun: info.noun,
      glyph: info.glyph,
      field_defs: (manifest.field_defs ?? []).map((f) => ({ ...f, entity_kind: `${instanceName}:item` })),
    },
  ];
  newManifest.field_defs = [];
  await meta
    .updateTable("bundles")
    .set({
      manifest: sql`${JSON.stringify(newManifest)}::jsonb` as never,
      version: "0.3.0",
      // enabled_features is a postgres text[] — bind a plain array (matches the
      // install path), NOT a ::jsonb cast.
      enabled_features: ["digifab"],
    })
    .where("id", "=", bundleId)
    .execute();

  // 6. Move the specialisation's existing machines into the instance. "Belongs"
  //    = what the lens showed: specialisation tag matches OR any spec field is
  //    populated. Only touches rows still on the default instance, so re-runs
  //    are a no-op.
  let machinesMoved = 0;
  const tdb = await getTenantDb(orgId);
  const conds = [
    sql`(metadata ->> 'specialisation') = ${instanceName}`,
    ...fieldNames.map((n) => sql`((metadata ->> ${n}) is not null and (metadata ->> ${n}) <> '')`),
  ];
  const belongs = sql.join(conds, sql` or `);
  const res = await sql<{ id: string }>`
    update machines_machines
       set instance = ${instanceName}
     where instance = 'machines' and (${belongs})
    returning id
  `.execute(tdb);
  machinesMoved = res.rows.length;

  return { migrated: true, machinesMoved };
}

/** Boot-time entry point. Scans `bundles` for any still-lens-shaped install of
 *  the three machine-specialisation bundles and converts each to the instance
 *  shape. Runs AFTER migrate-lens-modules (which creates the lens bundles). */
export async function migrateLensBundlesToInstances(): Promise<{
  orgsTouched: number;
  bundlesMigrated: number;
  machinesMoved: number;
}> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") {
    return { orgsTouched: 0, bundlesMigrated: 0, machinesMoved: 0 };
  }
  const rows = await meta
    .selectFrom("bundles")
    .select(["id", "org_id", "external_id", "manifest"])
    .where("external_id", "in", Object.keys(INSTANCE_META))
    .execute();
  // Filter to the ones still on the lens shape before opening any tenant pool.
  const targets = rows
    .map((r) => ({ ...r, parsed: parseManifest(r.manifest) }))
    .filter(
      (r) =>
        r.parsed &&
        r.parsed.provides_lens &&
        !(Array.isArray(r.parsed.provides_instances) && r.parsed.provides_instances.length > 0),
    );
  if (targets.length === 0) {
    return { orgsTouched: 0, bundlesMigrated: 0, machinesMoved: 0 };
  }

  let bundlesMigrated = 0;
  let machinesMoved = 0;
  const orgs = new Set<string>();
  // Group by org so each tenant pool opens/closes once (pre-listen, serial:
  // leaving every org's pool cached open exhausts Postgres max_connections).
  const byOrg = new Map<string, typeof targets>();
  for (const t of targets) {
    const list = byOrg.get(t.org_id);
    if (list) list.push(t);
    else byOrg.set(t.org_id, [t]);
  }
  for (const [orgId, bundles] of byOrg) {
    try {
      for (const b of bundles) {
        try {
          const out = await migrateOne(orgId, b.id, b.external_id, b.parsed!);
          if (out.migrated) {
            orgs.add(orgId);
            bundlesMigrated++;
            machinesMoved += out.machinesMoved;
          }
        } catch (err) {
          console.error(
            `[migrate-lens-bundles] ${b.external_id} on org ${orgId} failed:`,
            (err as Error).message,
          );
        }
      }
    } finally {
      await evictTenantPool(orgId);
    }
  }
  return { orgsTouched: orgs.size, bundlesMigrated, machinesMoved };
}
