// One-shot heal: a row filed before the commit recorded where it went gets
// that record, read once from the filed record itself.
//
// DONE WHEN: no tenant DB has a resolved core_scan_inbox_items row with a
// target_entity_id and no suggested_metadata->'filed_into'. Check with, per
// tenant:
//   select count(*) from core_scan_inbox_items
//    where status = 'resolved' and target_entity_id is not null
//      and suggested_metadata->'filed_into' is null;
// /healthz reports the count this pass found (noteHealShim). When it reads 0
// on prod, staging and dev, delete this file and its boot call. Nothing
// re-creates the shape: confirm and attach stamp filed_into on every filing.
//
// WHY IT EXISTS: Recently committed named a filed row from the base kind it
// kept ("part", module "inventory"), so bananas filed into Groceries read
// "→ Inventory", with a guessed "Groceries?" beside it (#3620). The instance
// was never recorded. It is still on the filed record (an inventory record
// carries its instance) or on the attach link; this reads it there, once.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { FILED_INTO_KEY, type FiledInto } from "@cobblr/platform-contract/scan-triage";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    target_module: string | null;
    target_kind: string | null;
    target_entity_id: string | null;
    suggested_metadata: unknown;
  };
}

export interface FiledRowLite {
  target_module: string | null;
  target_kind: string | null;
  suggested_metadata: unknown;
}

export interface InstanceLite {
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default: boolean;
}

/** The record where a filed row went, from what survives of the filing:
 *  the attach link's instance, else the filed record's own `instance`
 *  column. A module's default table is instance null. Pure. */
export function filedIntoFrom(row: FiledRowLite, recordInstance: string | null, instances: readonly InstanceLite[]): FiledInto | null {
  const module = row.target_module;
  if (!module) return null;
  const attached = ((row.suggested_metadata ?? {}) as { attached_to?: { instance?: unknown } }).attached_to;
  const raw = typeof attached?.instance === "string" && attached.instance ? attached.instance : recordInstance;
  const own = raw ? instances.find((i) => i.module_name === module && i.instance_name === raw) : undefined;
  const instance = own && !own.is_default ? own.instance_name : null;
  const table = own ?? instances.find((i) => i.module_name === module && i.is_default);
  const kind = row.target_kind ? (row.target_kind.includes(":") ? row.target_kind : instance ? `${instance}:item` : `${module}:${row.target_kind}`) : null;
  return { module, instance, kind, label: table?.display_name ?? module };
}

/** Heal one workspace: how many filed rows were missing their record, and
 *  whether every one of them was placed. */
export async function healFiledIntoIn(orgId: string, db: Kysely<HealDB>): Promise<{ found: number; settled: boolean }> {
  // Cheap on the happy path: only rows missing the record are read.
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "target_module", "target_kind", "target_entity_id", "suggested_metadata"])
    .where("status", "=", "resolved")
    .where("target_entity_id", "is not", null)
    .where((eb) => eb.or([eb("suggested_metadata", "is", null), eb.not(eb(eb.ref("suggested_metadata"), "?", FILED_INTO_KEY))]))
    .execute();
  if (rows.length === 0) return { found: 0, settled: true };
  const instances = (await platform().instances.list(orgId)) as unknown as InstanceLite[];
  let n = 0;
  for (const r of rows) {
    let recordInstance: string | null = null;
    if (r.target_module && r.target_kind && r.target_entity_id) {
      const kind = r.target_kind.includes(":") ? r.target_kind : `${r.target_module}:${r.target_kind}`;
      const snap = await platform().entities.snapshot(orgId, kind, r.target_entity_id).catch(() => null);
      recordInstance = typeof snap?.instance === "string" ? snap.instance : null;
    }
    const filed = filedIntoFrom(r, recordInstance, instances);
    if (!filed) continue;
    // Merged against the live row: only the record is added.
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ [FILED_INTO_KEY]: filed })}::jsonb` as never })
      .where("id", "=", r.id)
      .execute();
    n++;
  }
  if (n > 0) console.log(`[core-scan] org ${orgId}: recorded where ${n} filed row(s) went`);
  // A row filedIntoFrom cannot place still counts toward the DONE WHEN, but
  // no later round can place it either.
  return { found: rows.length, settled: true };
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. As a walk of its own at boot it failed 339 of 340
 *  workspaces on staging for want of a connection (#3647). */
export function registerFiledIntoHeal(): void {
  registerHealPass({
    name: "core-scan.heal-filed-into",
    shim: "modules/core-scan/src/heal-filed-into.ts",
    module: "core-scan",
    visit: ({ orgId, db }) => healFiledIntoIn(orgId, db as Kysely<HealDB>),
  });
}
