import { perReadRequest } from "../lib/request-context.js";
// A custom field reads back where it was written.
//
// A write takes a custom field at the top level (`{board: "Duet 2"}`: the
// write routes fold keys they do not own into the record's metadata), and the
// kind's own field list names it as a plain field. A read used to return it
// only inside `metadata`, so a client reading `fields.board` found nothing and
// reported the field empty on every one of 54 records that had it filled in
// (#3808). This lifts each DEFINED custom field's value to the top level on
// the way out, beside its copy in `metadata` (the app's detail panel reads
// that one), the same thing computed fields already do.
//
// Only defined fields are lifted: an importer's bookkeeping in the same bag
// (`source`, an old system's id) is not a field of the kind and stays where
// it is. A native column of the same name wins; a custom field never
// overwrites what the module itself returns.
//
// Runs after the read-scope projection, so it can only lift what this reader
// was already allowed to see.

import type { ResolvedEntity } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";

const TTL_MS = 5_000;
const cache = new Map<string, { at: number; names: string[] }>();

export function clearCustomFieldNamesCache(): void {
  cache.clear();
}

async function customFieldNames(orgId: string, kind: string): Promise<string[]> {
  return perReadRequest(`custom-field-names:${orgId}:${kind}`, () => loadCustomFieldNames(orgId, kind));
}

async function loadCustomFieldNames(orgId: string, kind: string): Promise<string[]> {
  const key = `${orgId}:${kind}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  let names: string[] = [];
  try {
    const rows = await meta
      .selectFrom("module_field_defs")
      .select("name")
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", kind)
      // A computed field is lifted by applyComputedFields, from its template.
      .where("type", "!=", "computed")
      .execute();
    names = rows.map((r) => r.name);
  } catch (err) {
    console.error(`[custom-field-values] defs query for ${key} failed:`, (err as Error).message);
    names = [];
  }
  cache.set(key, { at: Date.now(), names });
  return names;
}

/** Pure half, for the test: which values a record gains at the top level. */
export function liftCustomFieldValues(fields: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const metadata = fields.metadata && typeof fields.metadata === "object" && !Array.isArray(fields.metadata)
    ? (fields.metadata as Record<string, unknown>)
    : null;
  if (!metadata || names.length === 0) return fields;
  const lifted: Record<string, unknown> = {};
  for (const name of names) {
    if (name === "metadata" || Object.prototype.hasOwnProperty.call(fields, name)) continue;
    if (Object.prototype.hasOwnProperty.call(metadata, name)) lifted[name] = metadata[name];
  }
  return Object.keys(lifted).length ? { ...fields, ...lifted } : fields;
}

export async function applyCustomFieldValues(orgId: string, resolved: ResolvedEntity): Promise<ResolvedEntity> {
  const names = await customFieldNames(orgId, resolved.kind);
  if (names.length === 0) return resolved;
  const fields = liftCustomFieldValues(resolved.fields, names);
  return fields === resolved.fields ? resolved : { ...resolved, fields };
}
