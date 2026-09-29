// The generic interpreter for a declarative vendor scan-URL resolver manifest.
// `mapResponse` (pure) turns a fetched JSON payload into a ScanUrlResolution and
// is the equivalence-critical core; `runManifest` adds match → templated fetch →
// cache around it. See ./types.ts.

import type { ScanUrlResolution } from "@cobblr/platform-contract";
import { contactSuffix, operatorEmail } from "@cobblr/platform-contract/outbound-identity";
import type { FieldMap, ScanUrlResolverManifest } from "./types.js";
import { withPreset } from "./presets.js";
import { formatColour, MAX_COLOURS, normalizeColour } from "@cobblr/platform-contract/colour";

/** Walk a dotted path ("spool.material_name") into a JSON value. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function byte(n: unknown): number | null {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

/** One [r, g, b, a] slot as "#rrggbb", or null for an unused (alpha 0) or
 *  malformed one. The hex is read back through the platform's one colour
 *  rule so a tag's colour and a typed one are spelt alike. */
function rgbaSlot(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [r, g, b, a] = v.map(byte);
  if (r == null || g == null || b == null || a === 0) return null;
  return normalizeColour([r, g, b].map((n) => n.toString(16).padStart(2, "0")).join(""));
}

function coloursValue(root: unknown, fm: Extract<FieldMap, object>): string | null {
  // In order and with repeats: red / blue / red is three segments, and two
  // identical slots are two, as the tag says. Only an unused slot drops.
  const slots = (fm.colours ?? []).map((p) => rgbaSlot(getPath(root, p))).filter((c): c is string => !!c).slice(0, MAX_COLOURS);
  if (slots.length <= 1) {
    const name = fm.named_by ? getPath(root, fm.named_by) : null;
    if (typeof name === "string" && name.trim()) return name.trim();
    return slots[0] ?? null;
  }
  const said = (fm.gradient_if ?? []).map((p) => getPath(root, p)).filter((t): t is string => typeof t === "string").join(" ");
  return formatColour({ style: /\b(gradient|ombre|fade)\b/i.test(said) ? "gradient" : "multi", colours: slots });
}

function ymd(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [y, m, d] = v as unknown[];
  if (typeof y !== "number" || typeof m !== "number" || typeof d !== "number" || y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
  if (fm.zero_is_empty && v === 0) v = null;
  if (fm.colours) v = coloursValue(root, fm);
  if (fm.ymd) v = ymd(v);
  if (isBlank(v)) return fm.default ?? null;
  // Rounded so a tenth-of-a-mm encoding reads 0.3, not 0.30000000000000004.
  if (typeof fm.scale === "number" && typeof v === "number") v = Math.round(v * fm.scale * 1e6) / 1e6;
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
  const { response } = manifest;
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
  const output = withPreset(manifest.output);

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

/** Template `{key}`, `{env:VAR}` (with `env_defaults` fallback) and
 *  `{contact:email}` into a string.
 *
 *  `{contact:email}` is how a vendor that wants a contact address gets one
 *  WITHOUT the manifest naming anybody: it resolves to this instance's operator
 *  email. A manifest must never carry a literal address, because a manifest ships
 *  in the image and would then speak for every install — see outbound-identity.ts
 *  for the incident. */
function template(str: string, key: string, envDefaults: Record<string, string>): string {
  return str
    .replace(/\{key\}/g, encodeURIComponent(key))
    .replace(/\{contact:email\}/g, () => encodeURIComponent(operatorEmail()))
    .replace(/\{env:([A-Z0-9_]+)\}/g, (_, v: string) =>
      encodeURIComponent(process.env[v] ?? envDefaults[v] ?? ""),
    );
}

/** Does this manifest need the operator's contact address to make its call? */
function needsContactEmail(manifest: ScanUrlResolverManifest): boolean {
  const parts = [
    manifest.request.url,
    ...Object.values(manifest.request.headers ?? {}),
    manifest.request.body === undefined ? "" : JSON.stringify(manifest.request.body),
  ];
  return parts.some((s) => s.includes("{contact:email}"));
}

// One line per resolver per process, not per scan: a missing contact address is a
// standing configuration fact, and repeating it on every barcode would bury it.
const contactWarned = new Set<string>();

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

/** The longest a scan waits for its turn at a paced vendor before it gives up
 *  and falls through to the generic path. */
export const MAX_PACE_WAIT_MS = 20_000;

// When each paced vendor may next be called. A reservation, so scans that
// arrive together each take the next free slot rather than all waiting once.
const nextCallAt = new Map<string, number>();

/** Take this call's slot at a paced vendor; false when the queue is longer
 *  than a scan should wait. */
async function takeTurn(id: string, intervalMs: number): Promise<boolean> {
  const now = Date.now();
  const at = Math.max(now, nextCallAt.get(id) ?? 0);
  if (at - now > MAX_PACE_WAIT_MS) return false;
  nextCallAt.set(id, at + intervalMs);
  if (at > now) await new Promise<void>((r) => setTimeout(r, at - now));
  return true;
}

/** Test seam: forget every vendor's pace. */
export function resetPacing(): void {
  nextCallAt.clear();
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
  // A vendor that asked for a contact address gets a real one or no call at all.
  // Calling with the field blank invites a block for the whole software, and
  // calling with a baked-in address makes every install look like one caller.
  if (needsContactEmail(manifest) && !operatorEmail()) {
    if (!contactWarned.has(manifest.id)) {
      contactWarned.add(manifest.id);
      console.warn(
        `[scan-url-resolvers] ${manifest.id} needs a contact address for ${manifest.label} and is being skipped. ` +
          `Set COBBLR_OPERATOR_EMAIL (or SUPERADMIN_EMAILS) to an address the vendor can reach you at.`,
      );
    }
    return null;
  }
  const envDefaults = manifest.request.env_defaults ?? {};
  const url = template(manifest.request.url, key, envDefaults);
  const headers: Record<string, string> = {};
  for (const [h, v] of Object.entries(manifest.request.headers ?? {})) {
    headers[h] = template(v, key, envDefaults);
  }
  // The courtesy "who is calling" suffix is added HERE, not in the manifest, so
  // it covers operator-added resolver rows in scan_url_resolvers too — they are
  // written by people who have no reason to know the convention.
  const ua = Object.keys(headers).find((h) => h.toLowerCase() === "user-agent");
  if (ua && headers[ua] && !headers[ua].includes("(+")) headers[ua] += contactSuffix();
  const init: RequestInit = { method: manifest.request.method, headers };
  if (manifest.request.method === "POST" && manifest.request.body !== undefined) {
    init.body = template(JSON.stringify(manifest.request.body), key, envDefaults);
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  const pace = manifest.request.min_interval_ms ?? 0;
  const call = async (): Promise<Response | null> => {
    if (pace && !(await takeTurn(manifest.id, pace))) return null;
    return deps.fetch(url, { ...init, signal: AbortSignal.timeout(manifest.request.timeout_ms) });
  };
  let res = await call();
  // Turned away for going too fast says nothing about the product: ask once
  // more at the vendor's pace.
  if (res?.status === 429 && pace) res = await call();
  if (!res || !res.ok) return null;
  const json = await res.json().catch(() => null);
  if (json == null) return null;
  const resolution = mapResponse(json, manifest);
  if (resolution && ns) await deps.cachePut(ns, key, resolution).catch(() => {});
  return resolution;
}
