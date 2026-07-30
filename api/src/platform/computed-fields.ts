// Computed (template) fields. A field def of type='computed' carries a
// {{ }} template instead of a stored value; its value is rendered at
// entity-resolve time, so it reaches every read path uniformly — list
// rows, detail pages, search, export, the public surface.
//
// Two tiers, one mechanism:
//   Tier 1 — over the entity's own fields:
//     {{year}} {{manufacturer}} {{model}}            → "2019 Honda Civic"
//     {{qty}} {{unit}}                                → "340 g"
//   Tier 2 — over registered context providers (related / aggregated
//   data a module exposes under a namespace):
//     {{maintenance.last_performed}} ({{maintenance.last_performed_at | relative}})
//                                                     → "Oil change (2 weeks ago)"
//
// Tier 2 stays modular: a module registers a context provider via
// platform().entities.registerComputedContext("maintenance", fn). The
// engine only invokes a provider when some computed template on the kind
// actually references its namespace — zero cost otherwise, and the
// computed-fields layer never imports any specific module.

import { meta } from "../db/meta.js";
import { render } from "./templates.js";
import type { ResolvedEntity } from "@cobblr/platform-contract";

/** A provider returns a namespaced bag of related/aggregated data for one
 *  entity. Referenced in templates as {{<name>.<key>}}. Resolution is
 *  best-effort: a throw is swallowed and the namespace renders empty. */
export type ComputedContextProvider = (
  orgId: string,
  kind: string,
  id: string,
) => Promise<Record<string, unknown>>;

const providers = new Map<string, ComputedContextProvider>();

/** Register a tier-2 context provider under a namespace. Called from a
 *  module's boot via platform().entities.registerComputedContext(). */
export function registerComputedContext(
  name: string,
  provider: ComputedContextProvider,
): void {
  providers.set(name, provider);
}

interface ComputedDef {
  name: string;
  template: string;
  /** First path segment of every {{ }} ref in the template — used to
   *  decide which context providers to invoke. */
  refs: Set<string>;
}

// Computed defs are per (org, kind) and change rarely. A short TTL cache
// keeps a list() of N rows from doing N identical meta queries while still
// reflecting a field-def edit within a few seconds. clearComputedDefsCache
// is called on field-def writes for immediate freshness.
const TTL_MS = 5_000;
const cache = new Map<string, { at: number; defs: ComputedDef[] }>();

export function clearComputedDefsCache(): void {
  cache.clear();
}

/** A resolver's `metadata` field can come back as a parsed object or, on
 *  some driver paths, as the raw jsonb string. Normalise to an object so
 *  custom field values are always reachable as {{custom_field}}. */
function coerceMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* not JSON — ignore */
    }
  }
  return {};
}

const REF_PATTERN = /\{\{\s*([a-z0-9_.]+)/gi;
function topRefs(template: string): Set<string> {
  const refs = new Set<string>();
  for (const m of template.matchAll(REF_PATTERN)) {
    const seg = m[1]!.split(".")[0]!;
    refs.add(seg);
  }
  return refs;
}

async function computedDefsFor(orgId: string, kind: string): Promise<ComputedDef[]> {
  const key = `${orgId}:${kind}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.defs;
  let defs: ComputedDef[] = [];
  try {
    const rows = await meta
      .selectFrom("module_field_defs")
      .select(["name", "template"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", kind)
      .where("type", "=", "computed")
      .where("template", "is not", null)
      .execute();
    defs = rows
      .filter((r) => r.template)
      .map((r) => ({
        name: r.name,
        template: r.template as string,
        refs: topRefs(r.template as string),
      }));
  } catch (err) {
    console.error(`[computed-fields] defs query for ${key} failed:`, (err as Error).message);
    defs = [];
  }
  cache.set(key, { at: Date.now(), defs });
  return defs;
}

/** Inject computed-field values into a resolved entity. No-op (and no DB
 *  hit beyond the cached defs lookup) for kinds with no computed fields.
 *  Renders read-only — the values are never persisted; they're derived
 *  every read from the entity's own fields + tier-2 context providers.
 *
 *  Computed values are written into BOTH `fields[name]` (so list/table
 *  renderers that read `row.fields[field]` reach them) and
 *  `fields.metadata[name]` (where custom-field values live, so the
 *  detail panel shows them alongside other custom fields). */
export async function applyComputedFields(
  orgId: string,
  resolved: ResolvedEntity,
): Promise<ResolvedEntity> {
  const defs = await computedDefsFor(orgId, resolved.kind);
  if (defs.length === 0) return resolved;

  const fields = resolved.fields;
  const metadata = coerceMetadata(fields.metadata);

  // Tier-1 context: native fields (top-level) + custom values (metadata).
  // metadata wins on key collision since that's where authored values sit.
  const ctx: Record<string, unknown> = { ...fields, ...metadata };

  // Tier-2: invoke each registered provider whose namespace is referenced
  // by at least one computed template on this kind, once per entity.
  const wantedNamespaces = new Set<string>();
  for (const d of defs) for (const r of d.refs) if (providers.has(r) && !(r in ctx)) wantedNamespaces.add(r);
  await Promise.all(
    [...wantedNamespaces].map(async (ns) => {
      try {
        ctx[ns] = await providers.get(ns)!(orgId, resolved.kind, resolved.id);
      } catch (err) {
        console.error(
          `[computed-fields] context provider '${ns}' for ${resolved.kind}:${resolved.id} failed:`,
          (err as Error).message,
        );
        ctx[ns] = {};
      }
    }),
  );

  const computed: Record<string, unknown> = {};
  for (const d of defs) {
    computed[d.name] = render(d.template, ctx, { relative: true });
  }

  return {
    ...resolved,
    fields: {
      ...fields,
      ...computed,
      metadata: { ...metadata, ...computed },
    },
  };
}
