// Entity Kind Registry runtime. Two responsibilities:
//
//   1. The cobblr_meta.entity_kinds table is the source of truth
//      for "what kinds exist?". Populated at boot from each
//      module's manifest.provides.entityKinds.
//
//   2. Modules register an in-process resolver per kind they own;
//      the platform routes platform.entities.lookup() calls to
//      those resolvers. No HTTP loopback.

import type {
  EntityKindRecord,
  EntityResolver,
  ResolvedEntity,
} from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";

const resolvers = new Map<string, EntityResolver>();

export function registerResolver(kind: string, resolver: EntityResolver): void {
  resolvers.set(kind, resolver);
}

export async function lookup(
  orgId: string,
  kind: string,
  id: string,
): Promise<ResolvedEntity | null> {
  const resolver = resolvers.get(kind);
  if (!resolver) return null;
  try {
    return await resolver(orgId, id);
  } catch (err) {
    console.error(`[entities] resolver for ${kind} failed:`, err);
    return null;
  }
}

export async function listKinds(): Promise<EntityKindRecord[]> {
  const rows = await meta
    .selectFrom("entity_kinds")
    .selectAll()
    .orderBy("id")
    .execute();
  return rows.map(rowToKindRecord);
}

export async function getKind(kind: string): Promise<EntityKindRecord | null> {
  const row = await meta
    .selectFrom("entity_kinds")
    .selectAll()
    .where("id", "=", kind)
    .executeTakeFirst();
  return row ? rowToKindRecord(row) : null;
}

function rowToKindRecord(row: {
  id: string;
  module_name: string;
  display_name: string;
  display_name_plural: string | null;
  icon: string | null;
  fields: unknown;
  detail_route: string | null;
  endpoints: unknown;
  version: string;
  traits: unknown | null;
  profile: string | null;
}): EntityKindRecord {
  return {
    id: row.id,
    module_name: row.module_name,
    display_name: row.display_name,
    display_name_plural: row.display_name_plural,
    icon: row.icon,
    fields: (row.fields as EntityKindRecord["fields"]) ?? [],
    detail_route: row.detail_route,
    endpoints: (row.endpoints as EntityKindRecord["endpoints"]) ?? null,
    version: row.version,
    traits: (row.traits as EntityKindRecord["traits"]) ?? null,
    profile: row.profile,
  };
}
