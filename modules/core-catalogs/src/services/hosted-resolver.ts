// Client for the operator-hosted shared reference-catalog service (the cloud
// shared-catalog mode — docs/architecture/shared-reference-catalogs.md). When
// COBBLR_CATALOG_RESOLVER_URL is set, a catalog whose `source = "hosted"`
// resolves its rows/search/BOM from that service (read-only) instead of the
// tenant table; the shell + pairings stay local. Unset → every function reports
// "not configured" and callers fall back to the local table (today's behaviour),
// so this is inert on self-host and safe to ship before the service is deployed.
// (Env name mirrors COBBLR_BARCODE_RESOLVER_URL — the box .env sets it, the
// compose passes it 1:1 to the api container.)
//
// Outbound calls use plain fetch (NOT the tenant SSRF guard): BASE is an
// operator-set env, trusted infrastructure — same as the barcode resolver.

const BASE = (process.env.COBBLR_CATALOG_RESOLVER_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.COBBLR_CATALOG_RESOLVER_TOKEN ?? "";
const DEADLINE_MS = Number(process.env.COBBLR_CATALOG_RESOLVER_DEADLINE_MS ?? 8000);

export function catalogResolverConfigured(): boolean {
  return BASE.length > 0;
}

interface DatasetManifest {
  dataset: string;
  kinds: string[];
  /** Subset of `kinds` that /search can browse + search. Absent on older
   *  service versions → fall back to `kinds` (every held kind). */
  searchable?: string[];
  version?: string;
  counts?: Record<string, number>;
}

let datasetsCache: { at: number; data: DatasetManifest[] } | null = null;
const DATASETS_TTL_MS = 5 * 60 * 1000;

async function call<T>(_orgId: string, path: string): Promise<T | null> {
  if (!catalogResolverConfigured()) return null;
  const url = `${BASE}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEADLINE_MS);
  try {
    // Plain fetch, NOT platform().egress.guardedFetch — same as the barcode
    // resolver (core-scan/barcode-lookup.ts). BASE is an OPERATOR-configured env
    // (COBBLR_CATALOG_RESOLVER_URL), not a tenant-controlled URL, so there's no
    // SSRF surface to guard. On the hosted deployment the guard runs the strict
    // policy and blocks the resolver's private/CGNAT (Tailscale 100.64/10) IP —
    // which silently broke ALL hosted-catalog calls on the hosted service (empty results
    // → every catalog reported browsable:false). The guard is for tenant/user
    // URLs (webhooks, edge devices, sync), not trusted internal infrastructure.
    const res = await fetch(url, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The service's dataset manifest (cached). Drives hosted-eligibility. */
export async function fetchDatasets(orgId: string): Promise<DatasetManifest[]> {
  if (!catalogResolverConfigured()) return [];
  const now = Date.now();
  if (datasetsCache && now - datasetsCache.at < DATASETS_TTL_MS) return datasetsCache.data;
  const data = (await call<DatasetManifest[]>(orgId, "/datasets")) ?? [];
  datasetsCache = { at: now, data };
  return data;
}

/** Is a catalog hosted-ELIGIBLE — i.e. does the configured service actually hold
 *  its dataset? Matched by the catalog's stable identifiers (its
 *  bundle_external_id suffix, e.g. "rebrickable-parts", and/or its schema
 *  semantic_type, e.g. "lego.part"). A user's unknown catalog matches nothing →
 *  never eligible → stays local. */
export async function isHostedEligible(
  orgId: string,
  catalog: { bundle_external_id?: string | null; schema?: unknown },
): Promise<boolean> {
  if (!catalogResolverConfigured()) return false;
  const datasets = await fetchDatasets(orgId);
  if (datasets.length === 0) return false;
  const semanticType =
    typeof (catalog.schema as Record<string, unknown> | undefined)?.semantic_type === "string"
      ? ((catalog.schema as Record<string, unknown>).semantic_type as string)
      : "";
  const extId = catalog.bundle_external_id ?? "";
  const extSuffix = extId.includes("/") ? extId.slice(extId.lastIndexOf("/") + 1) : extId;
  // eligible if any dataset lists this catalog's semantic_type as a kind, or the
  // extId names a dataset the service holds (e.g. "rebrickable-*" → "rebrickable").
  return datasets.some(
    (d) =>
      (semanticType && d.kinds.includes(semanticType)) ||
      (extSuffix && extSuffix.startsWith(d.dataset)),
  );
}

/** The dataset (e.g. "rebrickable") the service holds a given kind
 *  (semantic_type, e.g. "lego.set") under — needed for /search + /lookup, which
 *  take dataset + kind. Null when no configured dataset holds the kind. */
export async function datasetForKind(orgId: string, kind: string): Promise<string | null> {
  if (!kind || !catalogResolverConfigured()) return null;
  const datasets = await fetchDatasets(orgId);
  return datasets.find((d) => d.kinds.includes(kind))?.dataset ?? null;
}

/** Can a kind be browsed/searched via /search? A kind can be HELD (eligible,
 *  in `kinds`) yet not searchable — the BOM is held to power Disassemble but
 *  isn't a browse target. Falls back to `kinds` if the service predates the
 *  `searchable` manifest field. */
export async function isHostedSearchable(orgId: string, kind: string): Promise<boolean> {
  if (!kind || !catalogResolverConfigured()) return false;
  const datasets = await fetchDatasets(orgId);
  return datasets.some((d) => (d.searchable ?? d.kinds).includes(kind));
}

// Response shapes mirror the service (scripts/reference-catalogs/src/server.mjs):
// /search → { results:[…] }, /lookup & /entry → { entry:{…} }, /bom → { parts:[…] }.
export interface HostedEntry {
  external_id: string;
  title?: string;
  name?: string;
  category?: string;
  image?: string;
  facets?: Record<string, unknown>;
  color?: { id: number; name: string | null } | null;
}

export function hostedSearch(
  orgId: string,
  dataset: string,
  kind: string,
  q: string,
  limit = 20,
  offset = 0,
): Promise<{ results: HostedEntry[] } | null> {
  // Empty q → the service browses (ordered listing, paged by offset); a q
  // searches. Both honour limit/offset. See reference-catalogs /search.
  const qs = new URLSearchParams({ dataset, kind, limit: String(limit) });
  if (q) qs.set("q", q);
  if (offset) qs.set("offset", String(offset));
  return call(orgId, `/search?${qs}`);
}

export function hostedLookup(
  orgId: string,
  dataset: string,
  kind: string,
  id: string,
  colorId?: string,
): Promise<{ entry: HostedEntry } | null> {
  const qs = new URLSearchParams({ dataset, kind, id });
  if (colorId) qs.set("color_id", colorId);
  return call(orgId, `/lookup?${qs}`);
}

export interface HostedBomRow {
  part_num: string;
  name: string;
  category?: string;
  color_id?: string;
  color_name?: string;
  quantity: number;
  is_spare: boolean;
  image?: string;
}

export function hostedBom(
  orgId: string,
  setNum: string,
  opts?: { include?: "minifigs" },
): Promise<{ set_num: string; parts: HostedBomRow[]; minifigs?: Array<{ fig_num: string; name: string; quantity: number; image?: string }> } | null> {
  const qs = new URLSearchParams({ dataset: "rebrickable", set_num: setNum });
  if (opts?.include) qs.set("include", opts.include);
  return call(orgId, `/bom?${qs}`);
}
