// The generic interpreter for a declarative vendor scan-URL resolver manifest.
// `mapResponse` (pure) turns a fetched JSON payload into a ScanUrlResolution and
// is the equivalence-critical core; `runManifest` adds match → templated fetch →
// cache around it. See ./types.ts.

import type { ScanUrlResolution } from "@cobblr/platform-contract";
import type { FieldMap, ScanUrlResolverManifest } from "./types.js";

/** Walk a dotted path ("spool.material_name") into a JSON value. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Resolve a FieldMap against the rooted response object. Strings are trimmed;
 *  empty → null. Mirrors the hand-written vendor resolvers' tolerant mapping. */
export function resolveField(root: unknown, fm: FieldMap): string | number | null {
  if (typeof fm === "string") {
    const v = getPath(root, fm);
    if (typeof v === "string") return v.trim() === "" ? null : v.trim();
    return typeof v === "number" ? v : null;
  }
  if (fm.concat) {
    const parts = fm.concat
      .map((p) => getPath(root, p))
      .map((v) => (typeof v === "string" ? v.trim() : v))
      .filter((v) => !isBlank(v));
    const s = parts.join(fm.sep ?? " ");
    return s !== "" ? s : (fm.fallback ?? null);
  }
  let v: unknown = fm.path ? getPath(root, fm.path) : null;
  if (isBlank(v)) return fm.default ?? null;
  if (typeof fm.scale === "number" && typeof v === "number") v = v * fm.scale;
  if (fm.stringify) v = String(v);
  if (fm.prefix !== undefined || fm.suffix !== undefined) {
    v = `${fm.prefix ?? ""}${typeof v === "string" ? v.trim() : v}${fm.suffix ?? ""}`;
  }
  return typeof v === "string" || typeof v === "number" ? v : null;
}

/** Pure: validate + map a fetched payload into a ScanUrlResolution (or null on a
 *  failed requirement / no identity). Unit-tested against captured vendor JSON. */
export function mapResponse(
  json: unknown,
  manifest: ScanUrlResolverManifest,
): ScanUrlResolution | null {
  const { response, output } = manifest;
  // Hard requirements: exact value (or "present" = any non-null).
  for (const [path, expected] of Object.entries(response.require ?? {})) {
    const actual = getPath(json, path);
    if (expected === "present") {
      if (isBlank(actual)) return null;
    } else if (actual !== expected) {
      return null;
    }
  }
  // At least one of these must be present (the vendor's identity fields).
  if (response.require_any && response.require_any.length > 0) {
    if (!response.require_any.some((p) => !isBlank(getPath(json, p)))) return null;
  }
  const root = response.root ? getPath(json, response.root) : json;
  if (root == null || typeof root !== "object") return null;

  const fields: Record<string, unknown> = {};
  for (const [key, fm] of Object.entries(output.fields)) fields[key] = resolveField(root, fm);
  const name = output.name ? resolveField(root, output.name) : null;
  return {
    source: output.source,
    name: name != null ? String(name) : "",
    brand: output.brand ? (resolveField(root, output.brand) as string | null) : null,
    category: output.category ?? null,
    entityType: output.entityType ?? null,
    fields,
    imageUrl: output.imageUrl ? (resolveField(root, output.imageUrl) as string | null) : null,
  };
}

/** Template `{key}` and `{env:VAR}` (with `env_defaults` fallback) into a string. */
function template(str: string, key: string, envDefaults: Record<string, string>): string {
  return str
    .replace(/\{key\}/g, encodeURIComponent(key))
    .replace(/\{env:([A-Z0-9_]+)\}/g, (_, v: string) =>
      encodeURIComponent(process.env[v] ?? envDefaults[v] ?? ""),
    );
}

/** Pull the `{key}` token out of a scanned value via the manifest's key regex. */
export function extractKey(manifest: ScanUrlResolverManifest, value: string): string | null {
  try {
    const m = value.match(new RegExp(manifest.match.key));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function matchesManifest(manifest: ScanUrlResolverManifest, value: string): boolean {
  if (!manifest.enabled) return false;
  try {
    return new RegExp(manifest.match.pattern, "i").test(value) && extractKey(manifest, value) != null;
  } catch {
    return false;
  }
}

export interface RunDeps {
  fetch: typeof fetch;
  cacheGet: (ns: string, key: string) => Promise<ScanUrlResolution | null>;
  cachePut: (ns: string, key: string, val: ScanUrlResolution) => Promise<void>;
}

/** Match → extract key → (cache) → templated fetch → mapResponse → (cache). */
export async function runManifest(
  manifest: ScanUrlResolverManifest,
  value: string,
  opts: { force?: boolean } | undefined,
  deps: RunDeps,
): Promise<ScanUrlResolution | null> {
  const key = extractKey(manifest, value);
  if (!key) return null;
  const ns = manifest.cache_ns;
  if (ns && !opts?.force) {
    const cached = await deps.cacheGet(ns, key).catch(() => null);
    if (cached) return cached;
  }
  const envDefaults = manifest.request.env_defaults ?? {};
  const url = template(manifest.request.url, key, envDefaults);
  const headers: Record<string, string> = {};
  for (const [h, v] of Object.entries(manifest.request.headers ?? {})) {
    headers[h] = template(v, key, envDefaults);
  }
  const init: RequestInit = {
    method: manifest.request.method,
    headers,
    signal: AbortSignal.timeout(manifest.request.timeout_ms),
  };
  if (manifest.request.method === "POST" && manifest.request.body !== undefined) {
    init.body = template(JSON.stringify(manifest.request.body), key, envDefaults);
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  const res = await deps.fetch(url, init);
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (json == null) return null;
  const resolution = mapResponse(json, manifest);
  if (resolution && ns) await deps.cachePut(ns, key, resolution).catch(() => {});
  return resolution;
}
