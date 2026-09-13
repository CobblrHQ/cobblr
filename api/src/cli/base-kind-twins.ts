// Who depends on a bundle's base-kind twin fields: a read-only count, per
// workspace, from inside the api container.
//
//   node dist/cli/base-kind-twins.js [--bundle cobblr.flagship.groceries] [--base inventory:part]
//
// The Groceries bundle carried a second copy of its food fields on the BASE
// kind inventory:part, kept for a workspace whose food still lived in plain
// Inventory before instances existed (#2860). Whether that twin can go turns
// on one fact per workspace: does plain Inventory hold rows that carry those
// fields? The meta side (which workspaces have the twin defs at all) is one
// query on cobblr_meta; the tenant side (rows in the default instance with any
// twin key filled) is one count per such workspace, through the api's own
// tenant pool, released after each. Nothing is written. The same count is the
// DONE WHEN of the reconcile that moves those rows into the instance.
//
// Runs INSIDE the api container (docker exec), like view-as: being inside is
// the authority, no token is minted, and the reads are the ones a tenant psql
// would have made by hand, unaudited, from a workstation.

import { writeSync } from "node:fs";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, evictTenantPool } from "../db/tenant.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function out(text: string): void {
  writeSync(1, text);
}
function fail(msg: string, code = 1): never {
  writeSync(2, msg + "\n");
  process.exit(code);
}

interface Row {
  slug: string;
  org_id: string;
  bundle_version: string | null;
  twin_defs: number;
  twin_fields: string[];
  instances: string[];
  rows_in_base_with_twin_values: number | null;
  error?: string;
}

async function main(): Promise<void> {
  const bundleExternalId = arg("bundle") ?? "cobblr.flagship.groceries";
  const base = arg("base") ?? "inventory:part";
  const [module] = base.split(":");
  if (!module) fail("--base must be <module>:<kind>");
  const defaultInstance = module;

  // META: every install of the bundle, with the twin defs it planted on the base kind.
  const installs = await meta
    .selectFrom("bundles as b")
    .innerJoin("orgs as o", "o.id", "b.org_id")
    .select(["b.id as bundle_id", "b.org_id", "b.version", "o.slug"])
    .where("b.external_id", "=", bundleExternalId)
    .orderBy("o.slug")
    .execute();
  const defs = installs.length
    ? await meta
        .selectFrom("module_field_defs")
        .select(["org_id", "bundle_id", "name"])
        .where("entity_kind", "=", base)
        .where("bundle_id", "in", installs.map((i) => i.bundle_id))
        .execute()
    : [];
  const twinByOrg = new Map<string, string[]>();
  for (const d of defs) twinByOrg.set(d.org_id, [...(twinByOrg.get(d.org_id) ?? []), d.name]);
  const instances = installs.length
    ? await meta
        .selectFrom("workspace_module_instances")
        .select(["org_id", "instance_name"])
        .where("module_name", "=", module)
        .where("org_id", "in", installs.map((i) => i.org_id))
        .execute()
    : [];
  const instByOrg = new Map<string, string[]>();
  for (const i of instances) instByOrg.set(i.org_id, [...(instByOrg.get(i.org_id) ?? []), i.instance_name]);

  // TENANT: rows in the default instance carrying any twin value.
  const rows: Row[] = [];
  for (const inst of installs) {
    const twin = twinByOrg.get(inst.org_id) ?? [];
    const row: Row = {
      slug: inst.slug,
      org_id: inst.org_id,
      bundle_version: inst.version ?? null,
      twin_defs: twin.length,
      twin_fields: twin,
      instances: instByOrg.get(inst.org_id) ?? [],
      rows_in_base_with_twin_values: null,
    };
    if (twin.length) {
      try {
        const tdb = await getTenantDb(inst.org_id);
        const filled = sql.join(
          twin.map((n) => sql`((metadata ->> ${n}) is not null and (metadata ->> ${n}) <> '')`),
          sql` or `,
        );
        const res = await sql<{ n: string }>`
          select count(*)::text as n from inventory_parts
           where instance = ${defaultInstance} and (${filled})
        `.execute(tdb);
        row.rows_in_base_with_twin_values = Number(res.rows[0]?.n ?? 0);
      } catch (err) {
        row.error = (err as Error).message;
      } finally {
        await evictTenantPool(inst.org_id).catch(() => undefined);
      }
    } else {
      row.rows_in_base_with_twin_values = 0;
    }
    rows.push(row);
  }

  const summary = {
    bundle: bundleExternalId,
    base_kind: base,
    installs: installs.length,
    workspaces_with_twin_defs: rows.filter((r) => r.twin_defs > 0).length,
    workspaces_with_rows_depending_on_twin: rows.filter((r) => (r.rows_in_base_with_twin_values ?? 0) > 0).length,
    rows_depending_on_twin: rows.reduce((n, r) => n + (r.rows_in_base_with_twin_values ?? 0), 0),
    errors: rows.filter((r) => r.error).length,
  };
  out(JSON.stringify({ summary, workspaces: rows }, null, 2) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => fail(`base-kind-twins: ${(err as Error).message}`));
