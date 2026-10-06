// The one writer for a module's contributed field defs (`contributes.fieldDefs`).
//
// Enabling a module calls it for one workspace, the boot reconcile
// (reconcile-contributed-fields) for every workspace with the module on, and
// creating a collection for that collection alone. A def on a module's primary
// kind is written for each of the module's named collections too
// (`<collection>:item`): a collection's items are that kind's rows, and
// without its own row a field read "tools:item has no field assigned_to", so a
// thing in a named collection could never be lent or given a due-back day.

import type { Insertable } from "kysely";
import { meta } from "../db/meta.js";
import type { ModuleFieldDefsTable } from "../db/schema.js";
import { list } from "../modules/registry.js";
import { clearServerManagedCache } from "./entities.js";
import { clearRelationDefsCache } from "./relation-fields.js";
import { clearMemberFieldCaches } from "./member-fields.js";
import { clearFieldLabelDefsCache } from "./field-labels.js";

export type ContributedFieldDef = {
  entity_kind: string;
  name: string;
  display_label: string;
  type: string;
  required?: boolean;
  position?: number;
  choices?: string[];
  renderer?: string;
  server_managed?: boolean;
  ref_kind?: string;
  field_role?: string;
};

/** Every kind in each workspace a def on `entityKind` belongs on: the kind
 *  itself, and, when it is a module's primary kind, each named collection of
 *  that module (the default one IS the primary kind). */
async function kindsCarrying(entityKind: string, orgIds: readonly string[]): Promise<Array<{ orgId: string; kind: string }>> {
  const out = orgIds.map((orgId) => ({ orgId, kind: entityKind }));
  const primary = await meta
    .selectFrom("entity_kinds")
    .select("module_name")
    .where("id", "=", entityKind)
    .where("is_primary", "=", true)
    .executeTakeFirst();
  if (!primary?.module_name || orgIds.length === 0) return out;
  const collections = await meta
    .selectFrom("workspace_module_instances")
    .select(["org_id", "instance_name"])
    .where("module_name", "=", primary.module_name)
    .where("org_id", "in", [...orgIds])
    .where("is_default", "=", false)
    .execute();
  for (const c of collections) out.push({ orgId: c.org_id, kind: `${c.instance_name}:item` });
  return out;
}

/** Insert one def's rows for every target whose workspace still exists, in
 *  one statement. A workspace deleted after the caller read its list (a test
 *  tearing its own down, a person deleting one during a boot) would fail the
 *  whole statement on the org foreign key and keep the field from every other
 *  workspace (#4937): the targets are re-read against `orgs` and, if one goes
 *  between that read and the write, written again without it. */
async function insertForLiveWorkspaces<T extends { orgId: string }>(targets: readonly T[], row: (t: T) => Insertable<ModuleFieldDefsTable>): Promise<number> {
  let left = [...targets];
  for (let attempt = 0; ; attempt++) {
    if (left.length === 0) return 0;
    const live = new Set((await meta.selectFrom("orgs").select("id").where("id", "in", [...new Set(left.map((t) => t.orgId))]).execute()).map((o) => o.id));
    left = left.filter((t) => live.has(t.orgId));
    if (left.length === 0) return 0;
    try {
      const rows = await meta
        .insertInto("module_field_defs")
        .values(left.map(row))
        .onConflict((b) => b.columns(["org_id", "entity_kind", "name"]).doNothing())
        .returning("id")
        .execute();
      return rows.length;
    } catch (err) {
      if ((err as { code?: string }).code !== "23503" || attempt >= 2) throw err;
    }
  }
}

/** Write these contributed field defs into the given workspaces where they are
 *  missing, on their kind and its collections. Returns the rows added. */
export async function applyContributedFieldDefs(
  moduleName: string,
  fieldDefs: ReadonlyArray<ContributedFieldDef>,
  orgIds: readonly string[],
): Promise<number> {
  if (fieldDefs.length === 0 || orgIds.length === 0) return 0;
  let added = 0;
  for (const fd of fieldDefs) {
    const rows = await insertForLiveWorkspaces(await kindsCarrying(fd.entity_kind, orgIds), ({ orgId, kind }) => ({
          org_id: orgId,
          entity_kind: kind,
          name: fd.name,
          display_label: fd.display_label,
          type: fd.type as never,
          required: fd.required ?? false,
          position: fd.position ?? 0,
          source_module: moduleName,
          choices: fd.choices ? JSON.stringify(fd.choices) : null,
          learns: (fd as { learns?: boolean }).learns ?? null,
          renderer: fd.renderer ?? null,
          server_managed: fd.server_managed ?? false,
          ref_kind: fd.ref_kind ?? null,
      field_role: fd.field_role ?? null,
    }));
    added += rows;
    // Whether the list learns is the module's to say (lint:field-learns-declared),
    // so a row it made before it said so follows the manifest: a workspace
    // born today and one from last month read the same field the same way.
    const learns = (fd as { learns?: boolean }).learns;
    if (typeof learns === "boolean") {
      await meta
        .updateTable("module_field_defs")
        .set({ learns })
        .where("org_id", "in", orgIds)
        .where("source_module", "=", moduleName)
        .where("name", "=", fd.name)
        .where((eb) => eb.or([eb("learns", "is", null), eb("learns", "!=", learns)]))
        .execute();
    }
  }
  // A contributed def may be server_managed, a relation or a member: drop the
  // per-kind caches so the next read/write sees it, not after the TTL.
  if (added > 0) {
    clearServerManagedCache();
    clearRelationDefsCache();
    clearMemberFieldCaches();
    clearFieldLabelDefsCache();
  }
  return added;
}

/** A new collection gets every enabled module's contributed defs on its
 *  module's primary kind, at once rather than at the next restart. */
export async function applyContributedFieldDefsToCollection(orgId: string, moduleName: string): Promise<number> {
  const primary = await meta
    .selectFrom("entity_kinds")
    .select("id")
    .where("module_name", "=", moduleName)
    .where("is_primary", "=", true)
    .executeTakeFirst();
  if (!primary) return 0;
  const on = new Set(
    (await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map((r) => r.module_name),
  );
  let added = 0;
  for (const m of list()) {
    if (!on.has(m.name)) continue;
    const defs = (m.contributes?.fieldDefs ?? []).filter((d) => d.entity_kind === primary.id);
    if (defs.length) added += await applyContributedFieldDefs(m.name, defs, [orgId]);
  }
  return added;
}
