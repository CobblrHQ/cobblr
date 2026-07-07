// Declarative sync engine — turns a SyncSourceManifest (data) into a
// SyncConnector at runtime. Installed as manifests, no deploy. Nothing
// source-specific lives in the kernel or the engine; "add the next source" is
// "install another manifest", never a code change. Mirrors digifab's
// declarative machine-driver engine (modules/digifab/src/drivers/declarative.ts).

import { Buffer } from "node:buffer";
import type {
  SyncConnector,
  SyncEntityType,
  SyncFetchContext,
  SyncRecord,
  SyncWebhookHit,
} from "@cobblr/platform-contract";
import type { FieldSpec, SyncEntityTypeManifest, SyncSourceManifest } from "./manifest.js";

/** Resolve a "$.a.b" dot-path against a record; "='lit'" returns the literal.
 *  Returns the RAW value (number/null/object preserved), undefined if missing. */
function resolve(expr: string, data: unknown): unknown {
  if (expr.startsWith("='") && expr.endsWith("'")) return expr.slice(2, -1);
  if (!expr.startsWith("$.")) return expr; // bare literal fallback
  let cur: unknown = data;
  for (const key of expr.slice(2).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Evaluate a FieldSpec against a source record → the mapped value. */
function evalField(spec: FieldSpec, data: unknown): unknown {
  if (typeof spec === "string") {
    const v = resolve(spec, data);
    return v === undefined ? null : v;
  }
  if ("object" in spec) {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(spec.object)) out[k] = evalField(sub, data);
    return out;
  }
  // coalesce: first sub-spec yielding a non-null/non-empty value wins.
  if ("coalesce" in spec) {
    for (const sub of spec.coalesce) {
      const v = evalField(sub, data);
      if (v !== null && v !== undefined && v !== "") return v;
    }
    return null;
  }
  // value-map spec: { from, valueMap?, default? }
  const raw = resolve(spec.from, data);
  if (spec.valueMap) {
    const mapped = spec.valueMap[String(raw)];
    if (mapped !== undefined) return mapped;
    if (spec.default !== undefined) return spec.default;
    return raw === undefined ? null : raw;
  }
  if ((raw === undefined || raw === null) && spec.default !== undefined) return spec.default;
  return raw === undefined ? null : raw;
}

/** A record passes the section filter when the extracted value matches the
 *  declared condition. No filter → everything passes. */
function passesFilter(et: SyncEntityTypeManifest, data: unknown): boolean {
  const f = et.filter;
  if (!f) return true;
  const v = resolve(f.from, data);
  const s = v == null ? "" : String(v);
  if (f.equals !== undefined && s !== f.equals) return false;
  if (f.notEquals !== undefined && s === f.notEquals) return false;
  if (f.in && !f.in.includes(s)) return false;
  return true;
}

/** The instance a row routes to via instanceBy, or null when instanceBy maps it
 *  nowhere and has no default — such a row is dropped, not imported. Also null
 *  when the section has no instanceBy (the static targetInstance applies). */
function instanceFor(et: SyncEntityTypeManifest, data: unknown): string | null {
  const ib = et.instanceBy;
  if (!ib) return null;
  const v = resolve(ib.from, data);
  return ib.map[v == null ? "" : String(v)] ?? ib.default ?? null;
}

/** A row is included only if it also resolves to an instance when the section
 *  uses instanceBy (an unmapped value with no default is skipped). */
function passesInstanceBy(et: SyncEntityTypeManifest, data: unknown): boolean {
  return !et.instanceBy || instanceFor(et, data) != null;
}

function mapRecord(et: SyncEntityTypeManifest, data: unknown): SyncRecord {
  const idVal = resolve(et.idField, data);
  const parentVal = et.parentField ? resolve(et.parentField, data) : null;
  const instance = instanceFor(et, data);
  const fields = evalField({ object: et.map }, data) as Record<string, unknown>;
  const references: Record<string, { section: string; externalId: string }> = {};
  if (et.references) {
    for (const [field, spec] of Object.entries(et.references)) {
      const v = resolve(spec.from, data);
      if (v != null) references[field] = { section: spec.section, externalId: String(v) };
    }
  }
  const images: Record<string, string> = {};
  if (et.images) {
    for (const [field, expr] of Object.entries(et.images)) {
      const v = resolve(expr, data);
      if (v != null && String(v).trim()) images[field] = String(v);
    }
  }
  return {
    externalId: String(idVal),
    parentExternalId: parentVal != null ? String(parentVal) : null,
    fields,
    ...(Object.keys(references).length ? { references } : {}),
    ...(Object.keys(images).length ? { images } : {}),
    ...(instance ? { instance } : {}),
  };
}

function authHeaders(manifest: SyncSourceManifest, ctx: SyncFetchContext): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const a = manifest.auth;
  if (a) {
    if (a.kind === "basic") {
      const u = String(ctx.credentials[a.userFrom] ?? "");
      const p = String(ctx.credentials[a.passFrom] ?? "");
      h.Authorization = "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
    } else {
      const v = String(ctx.credentials[a.from] ?? "");
      h[a.header] = `${a.prefix ?? ""}${v}`;
    }
  }
  return h;
}

/** The source base — a manifest's fixed `baseUrl` (e.g. api.ravelry.com) wins;
 *  otherwise the per-connection base the user entered. */
function baseFor(manifest: SyncSourceManifest, ctx: SyncFetchContext): string {
  return (manifest.baseUrl ?? ctx.baseUrl).replace(/\/+$/, "");
}

/** Substitute `{name}` tokens in a path with resolved bootstrap vars (URL-encoded).
 *  Unknown tokens (e.g. `{externalId}`, handled separately) are left intact. */
function substitutePath(path: string, vars: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? encodeURIComponent(vars[k]!) : m,
  );
}

/** Resolve the manifest's bootstrap vars ONCE (each a small GET read at `at`) —
 *  e.g. "who am I" before listing the caller's own data. Throws if a var can't
 *  be read (bad creds / unexpected shape), which surfaces as a failed sync. */
async function resolveVars(
  manifest: SyncSourceManifest,
  ctx: SyncFetchContext,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!manifest.resolveVars) return out;
  for (const [name, spec] of Object.entries(manifest.resolveVars)) {
    const body = await get(manifest, ctx, spec.method, spec.path);
    const v = resolve(spec.at, body);
    if (v == null || String(v) === "") {
      throw new Error(`${manifest.name}: could not resolve {${name}} from ${spec.path}`);
    }
    out[name] = String(v);
  }
  return out;
}

async function get(
  manifest: SyncSourceManifest,
  ctx: SyncFetchContext,
  method: string,
  path: string,
): Promise<unknown> {
  const base = baseFor(manifest, ctx);
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await ctx.fetch(url, { method, headers: authHeaders(manifest, ctx) });
  if (!res.ok) throw new Error(`${manifest.name} ${path} → ${res.status}`);
  return res.json();
}

/** Fetch a list section — paginated (page-numbered) or single-shot — returning
 *  the raw source rows before filter/map. */
async function fetchList(
  manifest: SyncSourceManifest,
  ctx: SyncFetchContext,
  et: SyncEntityTypeManifest,
  vars: Record<string, string>,
): Promise<unknown[]> {
  const basePath = substitutePath(et.list.path, vars);
  const readArray = (body: unknown): unknown[] => {
    const arr = et.list.arrayPath ? resolve(et.list.arrayPath, body) : body;
    return Array.isArray(arr) ? arr : [];
  };
  const pg = et.list.paginate;
  if (!pg) return readArray(await get(manifest, ctx, et.list.method, basePath));
  const rows: unknown[] = [];
  let page = pg.startPage;
  for (let n = 0; n < pg.maxPages; n++, page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    const q = `${pg.param}=${page}` + (pg.sizeParam ? `&${pg.sizeParam}=${pg.size}` : "");
    const items = readArray(await get(manifest, ctx, et.list.method, `${basePath}${sep}${q}`));
    rows.push(...items);
    if (items.length < pg.size) break; // short page → last page
  }
  return rows;
}

function buildEntityType(manifest: SyncSourceManifest, et: SyncEntityTypeManifest): SyncEntityType {
  return {
    key: et.key,
    label: et.label,
    targetKind: et.targetKind,
    targetInstance: et.targetInstance ?? null,
    async fetchBinary(ctx, urlOrPath) {
      try {
        const base = baseFor(manifest, ctx);
        const url = /^https?:\/\//.test(urlOrPath)
          ? urlOrPath
          : `${base}${urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`}`;
        const res = await ctx.fetch(url, {
          method: "GET",
          headers: { ...authHeaders(manifest, ctx), Accept: "image/*,*/*" },
        });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength === 0) return null;
        return { bytes: new Uint8Array(buf), mimeType: res.headers.get("content-type") || "application/octet-stream" };
      } catch {
        return null;
      }
    },
    async fetchAll(ctx) {
      const vars = await resolveVars(manifest, ctx);
      const items = await fetchList(manifest, ctx, et, vars);
      return items
        .filter((it) => passesFilter(et, it) && passesInstanceBy(et, it))
        .map((it) => mapRecord(et, it));
    },
    ...(et.item
      ? {
          async fetchOne(ctx: SyncFetchContext, externalId: string): Promise<SyncRecord | null> {
            try {
              const vars = await resolveVars(manifest, ctx);
              const path = substitutePath(et.item!.path, vars).replace(
                /\{externalId\}/g,
                encodeURIComponent(externalId),
              );
              const body = await get(manifest, ctx, et.item!.method, path);
              // itemPath points at the object; fall back to the bare body when
              // the source returns the object unwrapped.
              const obj = et.item!.itemPath ? (resolve(et.item!.itemPath, body) ?? body) : body;
              if (obj == null || typeof obj !== "object") return null;
              // Honour the section filter + instanceBy routing here too: a webhook
              // for a row this section excludes (a laser hitting the printers
              // section, or a value instanceBy maps nowhere) is a no-match.
              if (!passesFilter(et, obj) || !passesInstanceBy(et, obj)) return null;
              const rec = mapRecord(et, obj);
              return rec.externalId && rec.externalId !== "undefined" ? rec : null;
            } catch {
              return null;
            }
          },
        }
      : {}),
  };
}

/** Build a SyncConnector from a declarative manifest. */
export function buildSyncConnector(manifest: SyncSourceManifest): SyncConnector {
  const testPath = manifest.test?.path ?? manifest.entityTypes[0]!.list.path;
  const testMethod = manifest.test?.method ?? manifest.entityTypes[0]!.list.method;
  return {
    id: manifest.id,
    label: manifest.name,
    describeCredentials: () =>
      manifest.credentials
        ? Object.fromEntries(
            Object.entries(manifest.credentials).map(([k, v]) => [k, { label: v.label, secret: v.secret }]),
          )
        : { token: { label: manifest.credentialLabel ?? "API token", secret: true } },
    // A fixed-baseUrl source needs no user-entered base URL — hide the field.
    describeConfig: (): Record<string, { label: string; placeholder?: string }> =>
      manifest.baseUrl
        ? {}
        : {
            base_url: {
              label: manifest.baseUrlLabel ?? "Base URL",
              ...(manifest.baseUrlPlaceholder ? { placeholder: manifest.baseUrlPlaceholder } : {}),
            },
          },
    entityTypes: manifest.entityTypes.map((et) => buildEntityType(manifest, et)),
    async testConnection(ctx) {
      try {
        const vars = await resolveVars(manifest, ctx);
        await get(manifest, ctx, testMethod, substitutePath(testPath, vars));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    ...(manifest.webhook
      ? {
          parseWebhook(body: unknown): SyncWebhookHit | null {
            const w = manifest.webhook!;
            const entityRaw = String(resolve(w.entityField, body) ?? "");
            const entityType = w.entityValueMap?.[entityRaw] ?? entityRaw;
            const idVal = resolve(w.idField, body);
            if (!entityType || idVal == null) return null;
            if (!manifest.entityTypes.some((e) => e.key === entityType)) return null;
            const deleted = w.deletedField
              ? String(resolve(w.deletedField, body) ?? "") === (w.deletedWhen ?? "deleted")
              : false;
            const hit: SyncWebhookHit = { entityType, externalId: String(idVal), deleted };
            if (!deleted && w.recordPath) {
              const recObj = resolve(w.recordPath, body);
              const et = manifest.entityTypes.find((e) => e.key === entityType);
              if (et && recObj != null && typeof recObj === "object") hit.record = mapRecord(et, recObj);
            }
            return hit;
          },
        }
      : {}),
  };
}
