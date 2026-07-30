// Relation (entity-reference) fields. A field def of type='relation' stores a
// reference to another entity kind — the "link to another record" field. The
// stored VALUE is the target entity's id (in the metadata jsonb, like any custom
// field); at resolve time we look the target up and inject `<name>_label` with
// its title, so list rows + detail panels render a name, not a uuid. Read-only
// display — the stored id is never touched.
//
// Mirrors computed-fields.ts (same per-(org,kind) TTL cache + same
// fields/metadata injection), and hooks the SAME resolve points (lookup + list).
//
// Cycle safety: resolving a target runs the full lookup pipeline, which would
// re-enter this resolver. An AsyncLocalStorage depth guard resolves labels only
// at the top hop — a label's label is never needed and a relation cycle can't
// loop. (In practice the common target, core-locations:location, has no relation
// fields, so this is belt-and-braces.)

import { AsyncLocalStorage } from "node:async_hooks";
import { meta } from "../db/meta.js";
import { lookupMany } from "./entities.js";
import type { ResolvedEntity } from "@cobblr/platform-contract";

interface RelDef {
  name: string;
  ref_kind: string;
}

const TTL_MS = 5_000;
const cache = new Map<string, { at: number; defs: RelDef[] }>();
const relDepth = new AsyncLocalStorage<number>();

export function clearRelationDefsCache(): void {
  cache.clear();
}

async function relationDefsFor(orgId: string, kind: string): Promise<RelDef[]> {
  const key = `${orgId}:${kind}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.defs;
  let defs: RelDef[] = [];
  try {
    const rows = await meta
      .selectFrom("module_field_defs")
      .select(["name", "ref_kind"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", kind)
      .where("type", "=", "relation")
      .where("ref_kind", "is not", null)
      .execute();
    defs = rows
      .filter((r): r is { name: string; ref_kind: string } => !!r.ref_kind)
      .map((r) => ({ name: r.name, ref_kind: r.ref_kind }));
  } catch (err) {
    console.error(`[relation-fields] defs query for ${key} failed:`, (err as Error).message);
    defs = [];
  }
  cache.set(key, { at: Date.now(), defs });
  return defs;
}

function coerceMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  if (typeof raw === "string" && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") return p as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/** Inject `<name>_label` for each relation field on the entity, resolving the
 *  referenced target's title. No-op for kinds with no relation fields. Skips at
 *  depth > 0 so resolving a target can't recurse into another hop. */
export async function applyRelationFields(
  orgId: string,
  resolved: ResolvedEntity,
): Promise<ResolvedEntity> {
  if ((relDepth.getStore() ?? 0) > 0) return resolved;
  const defs = await relationDefsFor(orgId, resolved.kind);
  if (defs.length === 0) return resolved;

  const fields = resolved.fields;
  const metadata = coerceMetadata(fields.metadata);

  // Collect the (kind,id) refs to resolve — value lives in metadata (custom
  // fields) but tolerate a top-level value too.
  const refs: Array<{ kind: string; id: string; name: string }> = [];
  for (const d of defs) {
    const v = metadata[d.name] ?? fields[d.name];
    if (typeof v === "string" && v.trim()) refs.push({ kind: d.ref_kind, id: v, name: d.name });
  }
  if (refs.length === 0) return resolved;

  const targets = await relDepth.run(1, () =>
    lookupMany(orgId, refs.map((r) => ({ kind: r.kind, id: r.id }))),
  );
  const titleById = new Map(targets.map((t) => [`${t.kind}:${t.id}`, t.title]));

  const labels: Record<string, unknown> = {};
  for (const r of refs) {
    labels[`${r.name}_label`] = titleById.get(`${r.kind}:${r.id}`) ?? null;
  }

  return {
    ...resolved,
    fields: {
      ...fields,
      ...labels,
      metadata: { ...metadata, ...labels },
    },
  };
}
