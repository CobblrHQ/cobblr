// `member` fields store a user id. Nobody should ever SEE a user id.
//
// The sibling of relation-fields.ts, and for the same reason: the picker on the
// edit side is only half the job. A table cell, a list row, a card, an export
// and the API all render the STORED value, so without a resolved label the grid
// shows `39496c50-4037-45a3-9444-6a943515b32f` where a name belongs. That is
// exactly what shipped: the member field type was merged, typechecked, linted,
// unit-tested and documented as "showing their name rather than an id", and the
// first time anyone looked at a record it showed the uuid.
//
// So the read layer injects `<name>_label` with the display name, mirroring how
// a relation field injects its target's title.
//
// Resolved at READ time on purpose (household-accountability.md §1): renaming a
// member updates every record at once, rather than leaving snapshots behind.

import { meta } from "../db/meta.js";
import type { ResolvedEntity } from "@cobblr/platform-contract";

interface MemberDef {
  name: string;
}

const TTL_MS = 5_000;
const defsCache = new Map<string, { at: number; defs: MemberDef[] }>();
const namesCache = new Map<string, { at: number; names: Map<string, string> }>();

export function clearMemberFieldCaches(): void {
  defsCache.clear();
  namesCache.clear();
}

async function memberDefsFor(orgId: string, kind: string): Promise<MemberDef[]> {
  const key = `${orgId}:${kind}`;
  const hit = defsCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.defs;
  let defs: MemberDef[] = [];
  try {
    defs = await meta
      .selectFrom("module_field_defs")
      .select(["name"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", kind)
      .where("type", "=", "member")
      .execute();
  } catch {
    defs = []; // never fail a read over a label
  }
  defsCache.set(key, { at: Date.now(), defs });
  return defs;
}

/** Display names for everyone in the org, by user id. One query per org per
 *  TTL, not one per record: a list of 200 rows must not become 200 lookups. */
export async function memberNamesFor(orgId: string): Promise<Map<string, string>> {
  const hit = namesCache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  let names = new Map<string, string>();
  try {
    const rows = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select(["u.id as id", "u.display_name as display_name", "u.email as email"])
      .where("m.org_id", "=", orgId)
      .execute();
    names = new Map(rows.map((r) => [r.id, r.display_name || r.email]));
  } catch {
    names = new Map();
  }
  namesCache.set(orgId, { at: Date.now(), names });
  return names;
}

/**
 * Inject `<name>_label` for each member field on the entity. No-op for kinds
 * with no member fields.
 *
 * A user who has LEFT the workspace is not in the map, and resolves to
 * "Former member" rather than null: a record they were assigned should still
 * read as assigned to somebody, not silently look unclaimed.
 */
export async function applyMemberFields(
  orgId: string,
  resolved: ResolvedEntity,
): Promise<ResolvedEntity> {
  const defs = await memberDefsFor(orgId, resolved.kind);
  if (defs.length === 0) return resolved;

  const fields = resolved.fields;
  const metadata =
    fields.metadata && typeof fields.metadata === "object"
      ? (fields.metadata as Record<string, unknown>)
      : {};

  const present = defs
    .map((d) => ({ name: d.name, value: metadata[d.name] ?? fields[d.name] }))
    .filter((f) => typeof f.value === "string" && f.value.trim());
  if (present.length === 0) return resolved;

  const names = await memberNamesFor(orgId);
  const labels: Record<string, unknown> = {};
  for (const f of present) {
    labels[`${f.name}_label`] = names.get(String(f.value)) ?? "Former member";
  }

  return { ...resolved, fields: { ...fields, ...labels } };
}
