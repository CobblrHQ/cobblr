// Declarative sync engine — turns a SyncSourceManifest (data) into a
// SyncConnector at runtime. Installed as manifests, no deploy. Nothing
// source-specific lives in the kernel or the engine; "add the next source" is
// "install another manifest", never a code change. Mirrors digifab's
// declarative machine-driver engine (modules/digifab/src/drivers/declarative.ts).

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
  if (manifest.auth) {
    const v = String(ctx.credentials[manifest.auth.from] ?? "");
    h[manifest.auth.header] = `${manifest.auth.prefix ?? ""}${v}`;
  }
  return h;
}

async function get(
  manifest: SyncSourceManifest,
  ctx: SyncFetchContext,
  method: string,
  path: string,
): Promise<unknown> {
  const base = ctx.baseUrl.replace(/\/+$/, "");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await ctx.fetch(url, { method, headers: authHeaders(manifest, ctx) });
  if (!res.ok) throw new Error(`${manifest.name} ${path} → ${res.status}`);
  return res.json();
}

function buildEntityType(manifest: SyncSourceManifest, et: SyncEntityTypeManifest): SyncEntityType {
  return {
    key: et.key,
    label: et.label,
    targetKind: et.targetKind,
    targetInstance: et.targetInstance ?? null,
    async fetchBinary(ctx, urlOrPath) {
      try {
        const base = ctx.baseUrl.replace(/\/+$/, "");
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
      const body = await get(manifest, ctx, et.list.method, et.list.path);
      const arr = et.list.arrayPath ? resolve(et.list.arrayPath, body) : body;
      const items = Array.isArray(arr) ? arr : [];
      return items
        .filter((it) => passesFilter(et, it) && passesInstanceBy(et, it))
        .map((it) => mapRecord(et, it));
    },
    ...(et.item
      ? {
          async fetchOne(ctx: SyncFetchContext, externalId: string): Promise<SyncRecord | null> {
            try {
              const path = et.item!.path.replace(/\{externalId\}/g, encodeURIComponent(externalId));
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
    describeCredentials: () => ({
      token: { label: manifest.credentialLabel ?? "API token", secret: true },
    }),
    describeConfig: () => ({
      base_url: {
        label: manifest.baseUrlLabel ?? "Base URL",
        ...(manifest.baseUrlPlaceholder ? { placeholder: manifest.baseUrlPlaceholder } : {}),
      },
    }),
    entityTypes: manifest.entityTypes.map((et) => buildEntityType(manifest, et)),
    async testConnection(ctx) {
      try {
        await get(manifest, ctx, testMethod, testPath);
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
