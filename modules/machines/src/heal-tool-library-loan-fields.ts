// One-shot heal: the Tool Library's Borrower and Due back fields are hidden
// where nobody ever used them (#8627).
//
// DONE WHEN: no workspace with the Tool Library bundle still shows an unused
// Borrower or Due back field: no machines:machine `borrower` or `due_date`
// def from that bundle, made before this pass, lacks a native_field_overrides
// row while no machines_machines row holds a value in it. Check with, per
// workspace (meta):
//   select count(*) from module_field_defs d join bundles b on b.id = d.bundle_id
//    where b.external_id = 'cobblr.community.tool-library' and d.entity_kind = 'machines:machine'
//      and d.name in ('borrower','due_date') and not exists (select 1 from native_field_overrides o
//      where o.org_id = d.org_id and o.entity_kind = d.entity_kind and o.name = d.name);
// and read each count against that workspace's machines. /healthz reports the
// count (noteHealShim, through registerHealPass).
//
// BORN WITH: the bundle's 0.2.0 does not declare the two fields (the platform
// loan is the one record of who has a tool and until when), so a workspace
// installed from now on never has them.
//
// WHY IT EXISTS: 0.1.2 added a Borrower and a Due back field that the loan
// never filled, so the loan said who had the tool and the fields said nothing.
// Nothing is deleted: a field a person ever typed into stays shown and
// untouched, and one that was hidden is hidden, not removed (a person can show
// it again from the form builder, and a shown field is never hidden twice).

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";

export const TOOL_LIBRARY_BUNDLE = "cobblr.community.tool-library";
const KIND = "machines:machine";

/** What a visit reads and writes: the workspace's tables, or a test's memory. */
export interface ToolLibraryFieldsStore {
  /** The bundle's two fields this workspace still has made before the heal, with no override of a person's own. */
  untouched(): Promise<string[]>;
  /** Whether any machine holds a value in the field. */
  inUse(name: string): Promise<boolean>;
  /** Hide the field. Its values, if any, are not touched. */
  hide(name: string): Promise<void>;
}

/** Heal one workspace; answers how many unused fields it hid. */
export async function healToolLibraryFieldsIn(store: ToolLibraryFieldsStore): Promise<number> {
  let hidden = 0;
  for (const name of await store.untouched()) {
    if (await store.inUse(name)) continue;
    await store.hide(name);
    hidden++;
  }
  return hidden;
}

/** The meta tables a visit reads and writes, typed here as the module sees them. */
interface MetaTables {
  module_field_defs: { org_id: string; entity_kind: string; name: string; bundle_id: string | null; created_at: Date };
  bundles: { id: string; external_id: string };
  native_field_overrides: {
    org_id: string;
    entity_kind: string;
    name: string;
    display_label: string | null;
    hidden: boolean;
    position: number;
    bundle_id: string | null;
    source_module: string | null;
    section_id: string | null;
  };
}

export function kyselyToolLibraryFieldsStore(orgId: string, db: Kysely<unknown>, since: Date): ToolLibraryFieldsStore {
  const meta = () => platform().db.meta as unknown as Kysely<MetaTables>;
  return {
    untouched: async () => {
      const rows = await meta()
        .selectFrom("module_field_defs as d")
        .innerJoin("bundles as b", "b.id", "d.bundle_id")
        .select("d.name")
        .where("d.org_id", "=", orgId)
        .where("b.external_id", "=", TOOL_LIBRARY_BUNDLE)
        .where("d.entity_kind", "=", KIND)
        .where("d.name", "in", ["borrower", "due_date"])
        .where("d.created_at", "<", since)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("native_field_overrides as o")
                .select("o.name")
                .whereRef("o.org_id", "=", "d.org_id")
                .whereRef("o.entity_kind", "=", "d.entity_kind")
                .whereRef("o.name", "=", "d.name"),
            ),
          ),
        )
        .execute();
      return rows.map((r) => r.name);
    },
    inUse: async (name) => {
      const has = (await sql<{ ok: boolean }>`select to_regclass('public.machines_machines') is not null as ok`.execute(db)).rows[0]?.ok ?? false;
      if (!has) return false;
      const r = await sql<{ n: number }>`select count(*)::int as n from machines_machines where coalesce(metadata ->> ${name}, '') <> ''`.execute(db);
      return (r.rows[0]?.n ?? 0) > 0;
    },
    hide: async (name) => {
      await meta()
        .insertInto("native_field_overrides")
        .values({ org_id: orgId, entity_kind: KIND, name, display_label: null, hidden: true, position: 0, bundle_id: null, source_module: null, section_id: null })
        .onConflict((c) => c.columns(["org_id", "entity_kind", "name"]).doNothing())
        .execute();
    },
  };
}

/** Call from boot. A registered pass: the kernel's walk and budget. */
export function registerToolLibraryFieldsHeal(): void {
  registerHealPass({
    name: "machines.heal-tool-library-loan-fields",
    since: "2026-10-27T12:00:00Z",
    shim: "modules/machines/src/heal-tool-library-loan-fields.ts",
    module: "machines",
    visit: async ({ orgId, db, since }) => {
      const n = await healToolLibraryFieldsIn(kyselyToolLibraryFieldsStore(orgId, db as Kysely<unknown>, since));
      if (n) console.log(`[machines] org ${orgId}: hid ${n} unused Tool Library loan field${n === 1 ? "" : "s"}`);
      return n;
    },
  });
}
