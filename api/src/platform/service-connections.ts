// Connections of kind `service`: an external service that does work, connected
// once on Your account -> Connections (docs/design-decisions/services.md §6).
//
// A service connection is an ordinary personal connection. `user_credentials`
// holds it (provider_id = the manifest's own id, credentials = {base_url,
// transit, secret}) and `user_credential_orgs` its routes and its rank per
// capability, exactly as for an AI key. What is its own:
//
// - Where it is: a URL, or an address on the person's network reached
//   through their bridge (`transit`). Both are one contract: every hop is
//   `serviceFetch`, direct through the SSRF guard or relayed by the bridge.
// - What it does: the manifest at /.well-known/cobblr-service.json, read on
//   connect and on every Test, validated by the contract's one validator
//   (parseServiceManifest), and cached in `service_manifests`.
// - Whether it answers: a signed GET <base_path>/health. Signed, so a wrong
//   key reads as a wrong key and not as an unreachable service.
//
// The kernel's invoke reads connections back through serviceChainFor and
// serviceConnectionById, never the tables, so the order a page shows is the
// order a job walks.

import { productName } from "./product-name.js";
import { createHash } from "node:crypto";
import { EdgeOffline, EdgeTimeout, platform, type AiConnectionTest, type ConnectionProviderDef, type PreparedConnection } from "@cobblr/platform-contract";
import { SERVICE_KIND } from "@cobblr/platform-contract/connection-capability";
import { edgeRouteKey, edgeTransit } from "@cobblr/platform-contract/edge-channel";
import { parseServiceKey, signServiceRequest, type ServiceKey } from "@cobblr/platform-contract/service-auth";
import {
  ADAPTER_ADDRESS_KEY,
  ADAPTER_TRANSIT_KEY,
  adapterGroupOf,
  parseServiceManifest,
  SERVICE_MANIFEST_PATH,
  type AdapterFetch,
  type ServiceConnectionHolder,
  type ServiceManifest,
} from "@cobblr/platform-contract/services";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import * as connections from "./connections.js";
import { guardedFetch } from "./egress.js";
import { listBuiltIns, type ServiceConnectionPort, type ServiceConnectionRef } from "./services.js";
import { resolvePersonalProvider, rotateCredentialSecrets, storedCredentialById } from "./user-credentials.js";

/** One hop's budget. The job's length lives in the service; a hop is short. */
const HOP_TIMEOUT_MS = 20_000;
/** A manifest is a page of JSON; anything bigger is not one. */
const MANIFEST_MAX_BYTES = 512 * 1024;

/** Where a service is and how it is reached, as a hop needs it. */
export interface ServiceRoute {
  baseUrl: string;
  /** "" direct, "bridge" the owner's bridge, "bridge:<name>" a named one. */
  transit: string;
  /** The person whose bridge a bridge transit rides. */
  ownerUserId: string;
}

/** A stored service connection, read back for the kernel. */
export interface ServiceConnection extends ServiceRoute {
  credentialId: string;
  providerId: string;
  label: string;
  key: ServiceKey;
  manifest: ServiceManifest;
  manifestVersion: string;
}

/** One hop's answer: the status, the raw bytes, and a JSON reading of them. */
export interface ServiceHop {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  json: unknown;
  ms: number;
}

/** The address as typed, cleaned: an http(s) origin plus any path prefix,
 *  no trailing slash, no query. Null for anything else. */
export function normaliseBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

type HopMethod = "GET" | "POST" | "PUT" | "HEAD" | "PATCH" | "DELETE";

/** One hop to a service, signed when a key is given, direct or through the
 *  owner's bridge. The one door for a service request, so a Test and a job
 *  are signed and routed the same way. Direct is the SSRF-guarded fetch; a
 *  bridge is the platform's bridge hop. Nothing else about transport lives
 *  here.
 *
 *  `body` is a JSON value; `raw` sends bytes or a string as they are (a blob
 *  upload). The signature covers exactly the bytes sent. */
export async function serviceFetch(
  route: ServiceRoute,
  req: {
    method: HopMethod;
    path: string;
    body?: unknown;
    raw?: Uint8Array | string;
    headers?: Record<string, string>;
    key?: ServiceKey | null;
    timeoutMs?: number;
  },
): Promise<ServiceHop> {
  const payload: Uint8Array | string | undefined = req.raw ?? (req.body === undefined ? undefined : JSON.stringify(req.body));
  if (req.raw !== undefined && typeof req.raw !== "string" && edgeTransit(route.transit).viaBridge) {
    throw new Error("a file through a bridge travels on the bridge's file channel, which this server does not have yet");
  }
  const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
  if (req.raw === undefined && payload !== undefined) headers["content-type"] = "application/json";
  if (req.key) {
    Object.assign(
      headers,
      signServiceRequest({ keyId: req.key.keyId, secret: req.key.secret, method: req.method, pathAndQuery: req.path, body: payload ?? "" }),
    );
  }
  const timeoutMs = req.timeoutMs ?? HOP_TIMEOUT_MS;
  const started = Date.now();
  const { viaBridge, bridge } = edgeTransit(route.transit);
  const res = viaBridge
    ? // The platform's one bridge hop: held to the connection's origin, the
      // poll-gap retry, offline and timeout told apart by type.
      await platform().edge.fetch(edgeRouteKey({ ownerUserId: route.ownerUserId, bridge }), {
        baseUrl: route.baseUrl,
        path: req.path,
        method: req.method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        timeoutMs,
      })
    : // A person's own URL, so the SSRF guard applies. A personal connection
      // has no workspace to widen the policy for, so it reads the instance's.
      await guardedFetch("", `${route.baseUrl}${req.path}`, {
        method: req.method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  return { status: res.status, headers: outHeaders, bytes, json: tryJson(new TextDecoder().decode(bytes)), ms: Date.now() - started };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Why a hop never answered, in a sentence a person can act on. */
function unreachable(route: ServiceRoute, err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (edgeTransit(route.transit).viaBridge) {
    // EdgeOffline's message already names the bridge and what to do about it.
    if (err instanceof EdgeOffline) return `${msg} The service on your network is reached through it.`;
    if (err instanceof EdgeTimeout) return "Your bridge is connected, but the service on your network did not answer it in time.";
    return `The service could not be reached through your bridge: ${msg}`;
  }
  if (/egress:/.test(msg)) return `This server does not reach that address (${msg.replace(/^egress:\s*/, "")}). A service on your own network is reached through your bridge.`;
  return `The service did not answer at ${route.baseUrl}: ${msg}`;
}

export type ManifestRead =
  | { ok: true; manifest: ServiceManifest; manifestVersion: string }
  | { ok: false; status: 400 | 502; code: string; message: string; details?: unknown };

/** Read and validate a service's manifest. It is never signed: it says what
 *  the service does, never anything about a person. */
export async function readManifest(route: ServiceRoute): Promise<ManifestRead> {
  let hop: ServiceHop;
  try {
    hop = await serviceFetch(route, { method: "GET", path: SERVICE_MANIFEST_PATH });
  } catch (err) {
    return { ok: false, status: 502, code: "service_unreachable", message: unreachable(route, err) };
  }
  if (hop.status === 404) {
    return { ok: false, status: 400, code: "no_manifest", message: `There is no service at ${route.baseUrl}: it has no ${SERVICE_MANIFEST_PATH}. Check the address, including any path in front of it.` };
  }
  if (hop.status >= 400) return { ok: false, status: 502, code: "service_error", message: `The service answered ${hop.status} for its manifest.` };
  if (hop.bytes.length > MANIFEST_MAX_BYTES) return { ok: false, status: 400, code: "invalid_manifest", message: "The service's manifest is too large to be one." };
  if (hop.json === null || typeof hop.json !== "object") {
    return { ok: false, status: 400, code: "invalid_manifest", message: "The service's manifest is not JSON." };
  }
  const parsed = parseServiceManifest(hop.json);
  if (!parsed.ok) {
    const first = parsed.errors[0]!;
    return {
      ok: false,
      status: 400,
      code: "invalid_manifest",
      message: `The service's manifest is not valid: ${first.path} ${first.message}.`,
      details: parsed.errors,
    };
  }
  return { ok: true, manifest: parsed.manifest, manifestVersion: createHash("sha256").update(hop.bytes).digest("hex") };
}

/** Keep the manifest a connection was read with (connect, Test). */
export async function cacheManifest(credentialId: string, read: { manifest: ServiceManifest; manifestVersion: string }): Promise<void> {
  const row = { manifest: sql`${JSON.stringify(read.manifest)}::jsonb`, manifest_version: read.manifestVersion, fetched_at: new Date() };
  await meta
    .insertInto("service_manifests")
    .values({ credential_id: credentialId, ...row })
    .onConflict((oc) => oc.column("credential_id").doUpdateSet(row))
    .execute();
}

async function cachedManifest(credentialId: string): Promise<{ manifest: ServiceManifest; manifestVersion: string } | null> {
  const row = await meta.selectFrom("service_manifests").select(["manifest", "manifest_version"]).where("credential_id", "=", credentialId).executeTakeFirst();
  if (!row) return null;
  const parsed = parseServiceManifest(typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest);
  return parsed.ok ? { manifest: parsed.manifest, manifestVersion: row.manifest_version } : null;
}

function routeOf(credentials: Record<string, unknown>, ownerUserId: string): ServiceRoute | null {
  const baseUrl = normaliseBaseUrl(credentials.base_url);
  if (!baseUrl) return null;
  return { baseUrl, transit: typeof credentials.transit === "string" ? credentials.transit : "", ownerUserId };
}

const ownerOf = (credentials: Record<string, unknown>, fallback: string): string =>
  typeof credentials.__connection_user_id === "string" && credentials.__connection_user_id ? credentials.__connection_user_id : fallback;

/** What the form shows before saving, from a manifest. */
export function manifestPreview(m: ServiceManifest, manifestVersion: string) {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    publisher: m.publisher ?? null,
    docs_url: m.docs_url ?? null,
    requires: m.requires ?? [],
    manifest_version: manifestVersion,
    capabilities: m.capabilities.map((c) => ({ id: c.id, title: c.title, summary: c.summary, effect: c.effect, mode: c.mode })),
  };
}
export type ServicePreview = ReturnType<typeof manifestPreview>;

/** A connection being added or edited: where it is, what it is. */
async function prepare(credentials: Record<string, unknown>, ctx: { userId: string; credentialId?: string }): Promise<PreparedConnection> {
  const route = routeOf(credentials, ownerOf(credentials, ctx.userId));
  if (!route) return { ok: false, status: 400, code: "invalid_address", message: "Where the service is: an address starting http:// or https://." };
  const read = await readManifest(route);
  if (!read.ok) return read;
  const rawKey = typeof credentials.secret === "string" ? credentials.secret : "";
  if (rawKey.trim() && !parseServiceKey(rawKey)) {
    return { ok: false, status: 400, code: "invalid_key_shape", message: "That is not a key a service minted: it reads <key id>.<secret>, one string, as the service showed it." };
  }
  const stored = { base_url: route.baseUrl, transit: route.transit, ...(rawKey.trim() ? { secret: rawKey.trim() } : {}) };
  return {
    ok: true,
    providerId: read.manifest.id,
    label: read.manifest.name,
    credentials: stored,
    preview: manifestPreview(read.manifest, read.manifestVersion),
    afterSave: (credentialId) => cacheManifest(credentialId, read),
  };
}

/** The Test: re-read the manifest, then a signed GET <base_path>/health. The
 *  answer names the version and the time taken, or why it failed. */
export async function testServiceConnection(credentials: Record<string, unknown>, ctx: { userId: string; credentialId?: string }): Promise<AiConnectionTest> {
  const route = routeOf(credentials, ownerOf(credentials, ctx.userId));
  if (!route) return { ok: false, reason: "unknown", error: "This connection has no address." };
  const key = typeof credentials.secret === "string" ? parseServiceKey(credentials.secret) : null;
  if (!key) return { ok: false, reason: "invalid_key", error: "This connection holds no key the service minted (<key id>.<secret>)." };
  const read = await readManifest(route);
  if (!read.ok) return { ok: false, reason: read.status === 502 ? "unreachable" : "unknown", error: read.message };
  if (ctx.credentialId) await cacheManifest(ctx.credentialId, read);
  let hop: ServiceHop;
  try {
    hop = await serviceFetch(route, { method: "GET", path: `${read.manifest.api.base_path.replace(/\/+$/, "")}/health`, key });
  } catch (err) {
    return { ok: false, reason: "unreachable", error: unreachable(route, err) };
  }
  if (hop.status === 401 || hop.status === 403) {
    return { ok: false, reason: "invalid_key", error: `${read.manifest.name} did not accept this key. Mint a new one on the service and paste it here.` };
  }
  if (hop.status >= 500) return { ok: false, reason: "busy", error: `${read.manifest.name} answered ${hop.status} to its health check.` };
  const health = (hop.json ?? {}) as { ok?: unknown; version?: unknown };
  if (hop.status !== 200 || health.ok !== true) return { ok: false, reason: "unknown", error: `${read.manifest.name} did not say it is healthy (${hop.status}).` };
  const version = typeof health.version === "string" ? health.version : read.manifest.version;
  // What answered, where an AI connection names its model: the verified line
  // on the card reads "Tested … · Example slicer 1.4.0 · 12 ms".
  return { ok: true, models: [`${read.manifest.name} ${version}`], note: `${read.manifest.name} ${version}, answered in ${hop.ms} ms` };
}

/** The kind's definition: one entry that answers for every service, since
 *  each is named by its own manifest id. */
export const SERVICE_PROVIDER: ConnectionProviderDef = {
  id: SERVICE_KIND,
  kind: SERVICE_KIND,
  label: "A service",
  blurb: `Something that does work for you, installed by you: a slicer, a design service. ${productName()} reads what it offers from the service itself.`,
  credentials: {
    base_url: { label: "Where it is", secret: false },
    transit: { label: "How to reach it", secret: false },
    secret: { label: "Key", secret: true },
  },
  // Every service named by its manifest id; never an adapter's row, whose
  // adapter, when it is not installed, is simply not available here.
  anyProviderOfKind: (providerId) => !providerId.startsWith(ADAPTER_PREFIX),
  prepare,
  testConnection: testServiceConnection,
  capabilities: async (_creds, ctx) => {
    const cached = ctx.credentialId ? await cachedManifest(ctx.credentialId) : null;
    return cached ? cached.manifest.capabilities.map((c) => c.id) : [];
  },
};

/** A built-in service that needs a connection: a third-party API spoken by
 *  Cobblr's own code (a print-failure detector, a hosted model), connected
 *  like any service but configured by a form rather than read from a
 *  manifest (#4034, the adapters decision). */
export interface ServiceAdapter {
  /** The adapter's group (one program, however many capabilities); the
   *  connection is stored as `adapter:<group>`. */
  id: string;
  title: string;
  summary?: string;
  disconnect?: { stops: string; keeps: string };
  config_schema: {
    type: "object";
    properties: Record<string, { type: "string"; title: string; description?: string; format?: "uri"; writeOnly?: boolean; default?: string; enum?: string[]; enumLabels?: string[] }>;
    required?: string[];
  };
  test(config: Record<string, string>, ctx: { userId: string; orgId?: string; fetch?: AdapterFetch }): Promise<AiConnectionTest>;
}

export const ADAPTER_PREFIX = "adapter:";

/** The installed adapters: the kernel's built-ins that declare a connection. */
let adapterCatalogue: () => ServiceAdapter[] = () => {
  // One entry per group: a program with several capabilities is connected
  // once, and its first registered built-in speaks for it.
  const seen = new Set<string>();
  return listBuiltIns().flatMap((b) => {
    if (!b.connection) return [];
    const group = adapterGroupOf(b);
    if (seen.has(group)) return [];
    seen.add(group);
    return [{ id: group, title: b.connection.title, ...(b.connection.summary ? { summary: b.connection.summary } : {}), ...(b.connection.disconnect ? { disconnect: b.connection.disconnect } : {}), config_schema: b.connection.config_schema, test: b.connection.test } as ServiceAdapter];
  });
};
/** Where the installed adapters come from: the kernel's built-ins that
 *  declare a connection. Read each time the catalogue is asked for. */
export function setServiceAdapterCatalogue(list: () => ServiceAdapter[]): void {
  adapterCatalogue = list;
}

/** The typed config, without the platform's own `__` keys. */
function configOf(credentials: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(credentials).filter(([k, v]) => !k.startsWith("__") && typeof v === "string")) as Record<string, string>;
}

/** An adapter as a connection provider: its form from its config schema
 *  (writeOnly = a secret, stored encrypted and never shown again), its Test
 *  the adapter's own. */
export function adapterProvider(a: ServiceAdapter): ConnectionProviderDef {
  return {
    id: `${ADAPTER_PREFIX}${a.id}`,
    kind: SERVICE_KIND,
    label: a.title,
    ...(a.summary ? { blurb: a.summary } : {}),
    ...(a.disconnect ? { disconnect: a.disconnect } : {}),
    credentials: Object.fromEntries(
      Object.entries(a.config_schema.properties).map(([k, p]) => [
        k,
        {
          label: p.title,
          secret: p.writeOnly === true,
          ...(p.format ? { format: p.format } : {}),
          ...(p.enum?.length ? { choices: p.enum.map((value, i) => ({ value, label: p.enumLabels?.[i] || value || "Default" })) } : {}),
        },
      ]),
    ),
    // The Test reaches the program the way its jobs will: at this address,
    // directly or through this person's bridge.
    testConnection: (credentials, ctx) => {
      const config = configOf(credentials);
      const fetch = adapterFetchFor(config, ctx.userId);
      return a.test(config, { userId: ctx.userId, ...(fetch ? { fetch } : {}) });
    },
  };
}

/** Called once at boot. */
export function registerServiceConnections(): void {
  connections.registerProvider(SERVICE_PROVIDER);
  connections.registerProviderSource(() => adapterCatalogue().map(adapterProvider));
}

/** A stored service connection, read back for the kernel: its route, its
 *  key, and the manifest it was last read with. Null when it is gone, not a
 *  service, or holds no usable key or manifest. */
export async function serviceConnectionById(credentialId: string): Promise<ServiceConnection | null> {
  const row = await storedCredentialById(credentialId);
  if (!row || row.kind !== SERVICE_KIND) return null;
  const route = routeOf(row.credentials, row.user_id);
  const key = typeof row.credentials.secret === "string" ? parseServiceKey(row.credentials.secret) : null;
  const cached = await cachedManifest(credentialId);
  if (!route || !key || !cached) return null;
  const label = await meta.selectFrom("user_credentials").select("label").where("id", "=", credentialId).executeTakeFirst();
  return {
    ...route,
    credentialId,
    providerId: row.provider_id,
    label: label?.label || cached.manifest.name,
    key,
    manifest: cached.manifest,
    manifestVersion: cached.manifestVersion,
  };
}

/** The service connections this person may call in this workspace, in the
 *  order the page shows: the same walk AI's connections take (the person's
 *  own first, then shared ones), ranked for `capability` when one is given. */
async function walkIds(orgId: string, userId: string | null, capability?: string): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < 20; i++) {
    const next = await resolvePersonalProvider(orgId, userId, () => true, SERVICE_KIND, capability, undefined, seen);
    if (!next) break;
    seen.add(next.credentialId);
    out.push(next.credentialId);
  }
  return out;
}

async function walkServices(orgId: string, userId: string | null, capability?: string): Promise<ServiceConnection[]> {
  const out: ServiceConnection[] = [];
  for (const id of await walkIds(orgId, userId, capability)) {
    const conn = await serviceConnectionById(id);
    if (conn && (!capability || conn.manifest.capabilities.some((c) => c.id === capability))) out.push(conn);
  }
  return out;
}

/** The connections that serve `capability` in this workspace for this
 *  person, in order, kept to those whose manifest declares it. `via` pins one
 *  connection, with no fall-through. */
export async function serviceChainFor(
  orgId: string,
  userId: string | null,
  capability: string,
  opts: { via?: string } = {},
): Promise<ServiceConnection[]> {
  if (opts.via) {
    const one = await serviceConnectionById(opts.via);
    return one && one.manifest.capabilities.some((c) => c.id === capability) ? [one] : [];
  }
  return walkServices(orgId, userId, capability);
}

/** What the kernel sees of a connection: never its key or its address. */
function refOf(c: ServiceConnection, userId: string | null): ServiceConnectionRef {
  return {
    credentialId: c.credentialId,
    label: c.label,
    scope: userId && c.ownerUserId === userId ? "personal" : "shared",
    manifest: c.manifest,
    manifestVersion: c.manifestVersion,
  };
}

/** The kernel's door to connections (`setServiceConnectionPort`): the order,
 *  one by id, the list, and one signed hop under the manifest's base path.
 *  The kernel reads no key and no address; this does. */
/** The port, plus an adapter's config for the kernel to hand its built-in
 *  (`ctx.config`), read only when it runs one, so a connection ref never
 *  carries a secret. */
export type ServicePort = ServiceConnectionPort & {
  configFor(credentialId: string): Promise<Record<string, string> | null>;
  updateSecrets(credentialId: string, group: string, expected: Readonly<Record<string, string>>, patch: Readonly<Record<string, string>>): Promise<void>;
};

/** An adapter's connection as the kernel sees it: the built-ins of its
 *  group that run it, with a manifest made from their own declarations. Null
 *  when the adapter is not installed here. */
async function adapterRef(credentialId: string, userId: string | null): Promise<ServiceConnectionRef | null> {
  const row = await storedCredentialById(credentialId);
  if (!row || row.kind !== SERVICE_KIND || !row.provider_id.startsWith(ADAPTER_PREFIX)) return null;
  const group = row.provider_id.slice(ADAPTER_PREFIX.length);
  const defs = listBuiltIns().filter((b) => b.connection && adapterGroupOf(b) === group);
  const def = defs[0];
  if (!def) return null;
  const label = await meta.selectFrom("user_credentials").select("label").where("id", "=", credentialId).executeTakeFirst();
  const manifest: ServiceManifest = {
    cobblr_service: 1,
    id: group,
    name: def.name,
    version: "built-in",
    auth: { schemes: [] },
    api: { base_path: "/" },
    capabilities: defs.map((d) => d.capability),
  };
  return {
    credentialId,
    label: label?.label || def.connection!.title,
    scope: userId && row.user_id === userId ? "personal" : "shared",
    manifest,
    manifestVersion: `adapter:${group}`,
    adapter: group,
  };
}

/** An adapter's one way to its program: the config's address, directly
 *  through the SSRF guard or through the owner's bridge, by the config's
 *  transit. The adapter's own headers (its token) ride the request and are
 *  never logged here. Null when the config names no usable address. */
export function adapterFetchFor(config: Record<string, string>, ownerUserId: string): AdapterFetch | null {
  const baseUrl = normaliseBaseUrl(config[ADAPTER_ADDRESS_KEY]);
  if (!baseUrl) return null;
  const route: ServiceRoute = { baseUrl, transit: config[ADAPTER_TRANSIT_KEY] ?? "", ownerUserId };
  return async (req) => {
    const hop = await serviceFetch(route, {
      method: req.method ?? "GET",
      path: req.path.startsWith("/") ? req.path : `/${req.path}`,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    });
    return { status: hop.status, headers: hop.headers, bytes: hop.bytes, json: hop.json };
  };
}

/** Every service connection answering `capability` in this workspace, and
 *  whose: the shared ones a background call may use, then each member's own. */
async function holdersOf(orgId: string, capability: string): Promise<ServiceConnectionHolder[]> {
  const out = new Map<string, ServiceConnectionHolder>();
  const stored = async (id: string) => {
    const row = await storedCredentialById(id);
    const at = row?.credentials?.[ADAPTER_ADDRESS_KEY];
    return { owner: row?.user_id ?? null, address: typeof at === "string" && at.trim() ? at.trim() : null };
  };
  for (const ref of await refsFor(orgId, null, capability)) {
    const { owner: o, address } = await stored(ref.credentialId);
    if (o) out.set(ref.credentialId, { credentialId: ref.credentialId, label: ref.label, ownerUserId: o, shared: true, provider: ref.adapter ?? ref.manifest.id, address });
  }
  const members = await meta.selectFrom("org_memberships").select("user_id").where("org_id", "=", orgId).execute();
  for (const m of members) {
    for (const ref of await refsFor(orgId, m.user_id, capability)) {
      if (out.has(ref.credentialId)) continue;
      const { owner: o, address } = await stored(ref.credentialId);
      // Only a member's OWN connection is theirs to have matched for them;
      // a connection in their chain that belongs to someone else is shared.
      if (o === m.user_id) out.set(ref.credentialId, { credentialId: ref.credentialId, label: ref.label, ownerUserId: o, shared: false, provider: ref.adapter ?? ref.manifest.id, address });
    }
  }
  return [...out.values()];
}

/** Any service connection as the kernel sees it: a service at an address or
 *  an adapter. */
async function refFor(credentialId: string, userId: string | null): Promise<ServiceConnectionRef | null> {
  const c = await serviceConnectionById(credentialId);
  if (c) return refOf(c, userId);
  return adapterRef(credentialId, userId);
}

async function refsFor(orgId: string, userId: string | null, capability?: string): Promise<ServiceConnectionRef[]> {
  const out: ServiceConnectionRef[] = [];
  for (const id of await walkIds(orgId, userId, capability)) {
    const ref = await refFor(id, userId);
    if (ref && (!capability || ref.manifest.capabilities.some((c) => c.id === capability))) out.push(ref);
  }
  return out;
}

export function serviceConnectionPort(): ServicePort {
  return {
    configFor: async (credentialId) => {
      const row = await storedCredentialById(credentialId);
      if (!row || row.kind !== SERVICE_KIND || !row.provider_id.startsWith(ADAPTER_PREFIX)) return null;
      return configOf(row.credentials);
    },
    updateSecrets: async (credentialId, group, expected, patch) => {
      const adapter = adapterCatalogue().find(a => a.id === group);
      const properties = adapter?.config_schema.properties;
      if (!properties || !patch || typeof patch !== "object" || Array.isArray(patch)
        || Object.entries(patch).some(([key, value]) => key.startsWith("__") || !Object.hasOwn(properties, key) || properties[key]?.writeOnly !== true || typeof value !== "string")) {
        throw new Error("Only declared secret fields can be refreshed.");
      }
      if (!Object.keys(patch).length) return;
      const secrets = Object.fromEntries(Object.entries(properties).filter(([, property]) => property.writeOnly === true).map(([key]) => [key, expected[key]]));
      try {
        const saved = await rotateCredentialSecrets(credentialId, `${ADAPTER_PREFIX}${group}`, SERVICE_KIND, secrets, patch);
        if (saved) return;
      } catch {
        throw new Error("The refreshed credentials could not be saved.");
      }
      throw new Error("This connection changed or was removed. Reload it before refreshing credentials again.");
    },
    adapterFetch: async (credentialId) => {
      const row = await storedCredentialById(credentialId);
      if (!row || row.kind !== SERVICE_KIND || !row.provider_id.startsWith(ADAPTER_PREFIX)) return null;
      return adapterFetchFor(configOf(row.credentials), row.user_id);
    },
    holders: holdersOf,
    chainFor: async (orgId, userId, capability, opts) => {
      if (opts?.via) {
        const one = await refFor(opts.via, userId);
        return one && one.manifest.capabilities.some((c) => c.id === capability) ? [one] : [];
      }
      return refsFor(orgId, userId, capability);
    },
    byId: async (credentialId) => refFor(credentialId, null),
    list: async (orgId, userId) => refsFor(orgId, userId),
    fetch: async (credentialId, req) => {
      const c = await serviceConnectionById(credentialId);
      if (!c) throw new Error("that service connection is gone");
      const base = c.manifest.api.base_path.replace(/\/+$/, "");
      const method = req.method.toUpperCase();
      if (method !== "GET" && method !== "POST" && method !== "PUT" && method !== "HEAD") throw new Error(`a service hop is GET, POST, PUT or HEAD, not ${method}`);
      const hop = await serviceFetch(c, {
        method,
        path: `${base}${req.path}`,
        ...(req.body !== undefined ? { raw: req.body } : {}),
        ...(req.headers ? { headers: req.headers } : {}),
        key: c.key,
      });
      return { status: hop.status, headers: hop.headers, body: Buffer.from(hop.bytes) };
    },
  };
}
