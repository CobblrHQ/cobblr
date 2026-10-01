// The one writer for a module's contributed field defs (`contributes.fieldDefs`).
//
// Enabling a module calls it for one workspace, the boot reconcile
// (reconcile-contributed-fields) for every workspace with the module on, and
// creating a collection for that collection alone. A def on a module's primary
// kind is written for each of the module's named collections too
// (`<collection>:item`): a collection's items are that kind's rows, and
// without its own row a field read "tools:item has no field assigned_to", so a
// thing in a named collection could never be lent or given a due-back day.

import { meta } from "../db/meta.js";
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
    const targets = await kindsCarrying(fd.entity_kind, orgIds);
    const rows = await meta
      .insertInto("module_field_defs")
      .values(
        targets.map(({ orgId, kind }) => ({
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
        })),
      )
      .onConflict((b) => b.columns(["org_id", "entity_kind", "name"]).doNothing())
      .returning("id")
      .execute();
    added += rows.length;
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
