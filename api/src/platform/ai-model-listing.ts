// What models a connection can use, asked of the provider and remembered.
//
// A provider with a model catalog (anthropic-models.ts, openai-models.ts) is
// asked for its models with the connection's own key, and the answer is kept
// per connection (#5417):
//
//   - a call uses a listing up to 6 hours old, and past that asks again
//     BESIDE the call, so a new model reaches "latest" the same day it is
//     offered and no call ever waits on a listing it already has;
//   - a picker opening asks again when the listing is over an hour old, and
//     its "Refresh models" asks now;
//   - a call the provider answers "model not found" asks again at once.
//
// A listing that cannot be read falls back to the provider's one fallback
// list, and a listing that read before is kept rather than replaced by the
// guess. In this process's memory: a restart asks again on first use, which
// costs one free listing call.
//
// What it remembers in the workspace (core_ai_model_state) is only what must
// be said ONCE: the model each family's "latest" last meant, so a newer one is
// logged in the activity feed exactly once ("Haiku latest now means Haiku
// 5.6"); a retired pin, healed to its family's newest and said once; and the
// upgrade notice for selections that became "latest" when this shipped
// (migration 0016), said when the listing first shows what latest means.
//
// It also remembers, per connection, what a provider SERVES for a model it
// was asked for, learned from each call's served model: Google redirected
// every Gemini 3.5 Flash call to 3.6 Flash with no error and a listing that
// still offered 3.5. A redirect shows on the picker ("redirects to Flash
// 3.6"), and a family's latest counts the model it redirects to as served,
// so latest means what actually answers.

import { modelLabelOf, modelChoicesFor, newestOfFamily, versionText, resolveListedModel, isFloatingModel, servedModelDiffers, type AiListedModel, type AiModelCatalog, type AiModelRedirects } from "@cobblr/platform-contract/ai-models";
import { likeEscape, type AiCapability, type AiReportedModels } from "@cobblr/platform-contract";
import { getTenantDb } from "../db/tenant.js";
import * as activity from "./activity.js";

/** A call re-lists beside itself past this. */
export const LISTING_REFRESH_MS = 6 * 3600_000;
/** A picker opening re-lists past this. */
export const LISTING_PICKER_MAX_AGE_MS = 3600_000;
/** A listing that failed is asked again after this, whoever asks. */
export const LISTING_RETRY_MS = 5 * 60_000;

export interface ModelListing {
  /** When it was last asked (read or failed). */
  checkedAt: number;
  /** Read from the provider (true), or the fallback list standing in. */
  live: boolean;
  listed: AiListedModel[];
  /** Why the last ask failed, when it did. */
  error?: string;
}

let now = () => Date.now();
// per connection: requested id -> the id a call was answered by; loaded once per process from core_ai_model_state, set and cleared by noteServedModel
const redirects = new Map<string, Map<string, string>>();
// single-flight: one load per connection key from the workspace's store
const redirectLoads = new Map<string, Promise<void>>();

/** The workspace a connection key belongs to, and the connection within it. */
function splitKey(key: string): { orgId: string; conn: string } {
  const i = key.indexOf("|");
  return { orgId: key.slice(0, i), conn: key.slice(i + 1) };
}

/** Where a learned redirect is kept: one row per connection and requested
 *  model. The trailing "|" ends the id, so taking one model's row never takes
 *  a longer id that starts with it (3.5-flash and 3.5-flash-lite). */
function redirectStateKey(conn: string, requested?: string): string {
  return `redirect:${conn}|${requested === undefined ? "" : `${requested}|`}`;
}

/** Read what this connection's calls taught earlier (another process, or
 *  before a restart), once per process. A store that cannot be read leaves
 *  only what this process learned, and is asked again next time. */
export function loadRedirects(key: string): Promise<void> {
  if (redirects.has(key)) return Promise.resolve();
  const inFlight = redirectLoads.get(key);
  if (inFlight) return inFlight;
  const { orgId, conn } = splitKey(key);
  const prefix = redirectStateKey(conn);
  const p = (async () => {
    const rows = await store.list(orgId, prefix);
    const m = redirects.get(key) ?? new Map<string, string>();
    for (const r of rows) {
      const requested = r.key.slice(prefix.length).replace(/\|$/, "");
      try {
        const v = JSON.parse(r.value) as { served?: unknown };
        if (requested && typeof v.served === "string" && !m.has(requested)) m.set(requested, v.served);
      } catch {
        /* a row this code cannot read teaches nothing */
      }
    }
    redirects.set(key, m);
  })()
    .catch((err) => console.warn(`[core-ai] could not read the redirects learned for ${conn}: ${(err as Error).message}`))
    .finally(() => redirectLoads.delete(key));
  redirectLoads.set(key, p);
  return p;
}

/** What one connection's calls have shown it redirects, or undefined when
 *  none. Reads this process's copy: loadRedirects first. */
export function redirectsFor(key: string): AiModelRedirects | undefined {
  const m = redirects.get(key);
  return m?.size ? Object.fromEntries(m) : undefined;
}

/**
 * Learn from one answered call what the connection serves for the model it
 * sent. A served model that is another model is a redirect, remembered in
 * the workspace (core_ai_model_state, with when it was learned) until a call
 * is answered by the model itself again; a floating alias answered by a
 * numbered model is the alias working, and a missing served model is
 * unknown, so neither changes anything. True when this call learned a new
 * redirect.
 */
export async function noteServedModel(key: string, requested: string, served: string | null | undefined, catalog?: AiModelCatalog): Promise<boolean> {
  if (!served || isFloatingModel(requested) || catalog?.familyOfLatest(requested)) return false;
  const bare = served.trim().replace(/^models\//, "");
  const a = catalog?.parse(requested);
  const b = catalog?.parse(bare);
  const same = !servedModelDiffers(requested, bare) || (!!a && !!b && a.family === b.family && versionText(a.version) === versionText(b.version));
  await loadRedirects(key);
  const learned = redirects.get(key) ?? new Map<string, string>();
  redirects.set(key, learned);
  const { orgId, conn } = splitKey(key);
  const stateKey = redirectStateKey(conn, requested);
  if (same) {
    if (learned.delete(requested)) await store.take(orgId, stateKey);
    return false;
  }
  if (learned.get(requested) === bare) return false;
  learned.set(requested, bare);
  const value = JSON.stringify({ served: bare, learned_at: new Date(now()).toISOString() });
  const was = await store.get(orgId, stateKey);
  await store.swap(orgId, stateKey, was, value);
  return true;
}

// single-flight: a miss starts one listing in `flights`, and every asker meanwhile awaits it
const listings = new Map<string, ModelListing>();
const flights = new Map<string, Promise<ModelListing>>();

function redact(message: string, credentials: Record<string, unknown>): string {
  let out = message;
  for (const v of Object.values(credentials)) if (typeof v === "string" && v.length >= 8) out = out.split(v).join("[redacted]");
  return out;
}

function readListing(key: string, catalog: AiModelCatalog, credentials: Record<string, unknown>): Promise<ModelListing> {
  const inFlight = flights.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    let entry: ModelListing;
    try {
      entry = { checkedAt: now(), live: true, listed: await catalog.list(credentials) };
    } catch (err) {
      const error = redact((err as Error)?.message ?? String(err), credentials);
      const prev = listings.get(key);
      entry = prev?.live ? { ...prev, checkedAt: now(), error } : { checkedAt: now(), live: false, listed: [...catalog.fallback], error };
    }
    listings.set(key, entry);
    return entry;
  })().finally(() => flights.delete(key));
  flights.set(key, p);
  return p;
}

/** The listing for one connection. `maxAgeMs` is how old an answer may be;
 *  `background` serves an older one now and re-lists beside it. */
export async function listingFor(
  key: string,
  catalog: AiModelCatalog,
  credentials: Record<string, unknown>,
  opts: { maxAgeMs: number; fresh?: boolean; background?: boolean },
): Promise<ModelListing> {
  const hit = listings.get(key);
  const limit = hit?.error ? LISTING_RETRY_MS : opts.maxAgeMs;
  if (hit && !opts.fresh && now() - hit.checkedAt <= limit) return hit;
  if (hit && opts.background && !opts.fresh) {
    void readListing(key, catalog, credentials);
    return hit;
  }
  return readListing(key, catalog, credentials);
}

/** The key one connection's listing is kept under: a personal connection by
 *  its id, a workspace's own provider by the workspace and provider. */
export function listingKey(orgId: string, ref: { credentialId?: string | null; providerId: string }): string {
  return ref.credentialId ? `${orgId}|${ref.credentialId}` : `${orgId}|ws:${ref.providerId}`;
}

/**
 * Which models a connection can use for a job, latest entries first, then
 * the exact versions to pin. THE function a picker asks, and the one a
 * per-person default (#5422) asks for a connection outside any workspace:
 * hand it the provider's catalog, the connection's decrypted credentials and
 * a key of its own (`user:<credential id>`).
 *
 * Without a capability, every listed model is in `models` and `choices`
 * holds every family's latest; with one, only what the job's rule accepts.
 */
export async function connectionModelChoices(args: {
  key: string;
  catalog: AiModelCatalog;
  credentials: Record<string, unknown>;
  capability?: AiCapability;
  fresh?: boolean;
  maxAgeMs?: number;
}): Promise<AiReportedModels & { live: boolean; listed: AiListedModel[] }> {
  const [listing] = await Promise.all([
    listingFor(args.key, args.catalog, args.credentials, { maxAgeMs: args.maxAgeMs ?? LISTING_PICKER_MAX_AGE_MS, fresh: args.fresh }),
    loadRedirects(args.key),
  ]);
  const served = redirectsFor(args.key);
  const choices = args.capability
    ? modelChoicesFor(args.catalog, args.capability, listing.listed, served)
    : modelChoicesFor(args.catalog, "chat", listing.listed, served).filter((c) => c.latest);
  const models = args.capability ? choices.map((c) => c.id) : [...choices.map((c) => c.id), ...listing.listed.map((m) => m.id)];
  return {
    ok: true,
    models: [...new Set(models)],
    choices,
    ...(listing.live ? {} : { fallback: listing.error ?? "the provider could not be asked" }),
    live: listing.live,
    listed: listing.listed,
  };
}

// ── What is said once, remembered in the workspace ──────────────────────────

/** Where what must be said once is remembered. The default is the
 *  workspace's own core_ai_model_state; tests hand in a map. */
export interface ModelStateStore {
  get(orgId: string, key: string): Promise<string | null>;
  /** Set `key` to `value` only if it still holds `expected` (null: only if
   *  absent). True when this call made the change, so only one caller says it. */
  swap(orgId: string, key: string, expected: string | null, value: string): Promise<boolean>;
  /** Take and remove every row whose key starts with `prefix`. */
  take(orgId: string, prefix: string): Promise<Array<{ key: string; value: string }>>;
  /** Every row whose key starts with `prefix`, left in place. */
  list(orgId: string, prefix: string): Promise<Array<{ key: string; value: string }>>;
}

type StateDb = {
  selectFrom: (t: string) => {
    select: (c: string[]) => {
      where: (a: string, op: string, v: unknown) => {
        executeTakeFirst: () => Promise<{ value: string } | undefined>;
        execute: () => Promise<Array<{ key: string; value: string }>>;
      };
    };
  };
  insertInto: (t: string) => { values: (v: Record<string, unknown>) => { onConflict: (f: (c: { column: (c: string) => { doNothing: () => unknown } }) => unknown) => { executeTakeFirst: () => Promise<{ numInsertedOrUpdatedRows?: bigint }> } } };
  updateTable: (t: string) => { set: (v: Record<string, unknown>) => { where: (a: string, op: string, v: unknown) => { where: (a: string, op: string, v: unknown) => { executeTakeFirst: () => Promise<{ numUpdatedRows?: bigint }> } } } };
  deleteFrom: (t: string) => { where: (a: string, op: string, v: unknown) => { returning: (c: string[]) => { execute: () => Promise<Array<{ key: string; value: string }>> } } };
};

const tenantStore: ModelStateStore = {
  async get(orgId, key) {
    const db = (await getTenantDb(orgId)) as unknown as StateDb;
    return (await db.selectFrom("core_ai_model_state").select(["value"]).where("key", "=", key).executeTakeFirst())?.value ?? null;
  },
  async swap(orgId, key, expected, value) {
    const db = (await getTenantDb(orgId)) as unknown as StateDb;
    if (expected === null) {
      const r = await db.insertInto("core_ai_model_state").values({ key, value }).onConflict((c) => c.column("key").doNothing()).executeTakeFirst();
      return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
    }
    const r = await db.updateTable("core_ai_model_state").set({ value, updated_at: new Date() }).where("key", "=", key).where("value", "=", expected).executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0) > 0;
  },
  async take(orgId, prefix) {
    const db = (await getTenantDb(orgId)) as unknown as StateDb;
    return db.deleteFrom("core_ai_model_state").where("key", "like", `${likeEscape(prefix)}%`).returning(["key", "value"]).execute();
  },
  async list(orgId, prefix) {
    const db = (await getTenantDb(orgId)) as unknown as StateDb;
    return db.selectFrom("core_ai_model_state").select(["key", "value"]).where("key", "like", `${likeEscape(prefix)}%`).execute();
  },
};

/** How a sentence reaches the workspace's activity feed. */
export type ModelNotice = (orgId: string, about: string, sentence: string) => Promise<void>;

const activityNotice: ModelNotice = (orgId, about, sentence) =>
  activity.log({ orgId, userId: null, action: "ai_model_changed", ref: { module: null, entityType: "ai-model", entityId: about }, diff: { name: sentence }, via: null });

let store: ModelStateStore = tenantStore;
let notice: ModelNotice = activityNotice;
/** What this process already knows was remembered, so a settled workspace
 *  costs no query per call. */
const known = new Map<string, string>();

/** Latest moved: log once, across every process and restart. */
async function noteLatest(orgId: string, providerId: string, catalog: AiModelCatalog, family: string, model: string): Promise<void> {
  const key = `latest:${providerId}:${family}`;
  if (known.get(`${orgId}|${key}`) === model) return;
  const was = await store.get(orgId, key);
  if (was === null) await store.swap(orgId, key, null, model);
  else if (was !== model && (await store.swap(orgId, key, was, model))) {
    await notice(orgId, family, `${catalog.familyLabel(family)} latest now means ${modelLabelOf(catalog, model)}.`);
  }
  known.set(`${orgId}|${key}`, model);
}

/** A pin the provider no longer lists: said once. */
async function noteRetired(orgId: string, providerId: string, catalog: AiModelCatalog, from: string, to: string): Promise<void> {
  const key = `retired:${providerId}:${from}`;
  if (known.has(`${orgId}|${key}`)) return;
  if (await store.swap(orgId, key, null, to)) {
    await notice(orgId, from, `${modelLabelOf(catalog, from)} is no longer offered, so what was pinned to it now uses ${modelLabelOf(catalog, to)}. Pick another version in Configuration → AI to change it.`);
  }
  known.set(`${orgId}|${key}`, to);
}

/** The upgrade's notice: selections made before "latest" existed became
 *  their family's latest (migration 0016 left one row per family it moved),
 *  said once per workspace, with the version latest means now. Waits for a
 *  live listing: a fallback is a guess, not news. */
export async function flushUpgradeNotice(orgId: string, providerId: string, catalog: AiModelCatalog, listing: ModelListing): Promise<void> {
  if (!listing.live) return;
  const flag = `${orgId}|upgrade:${providerId}`;
  if (known.has(flag)) return;
  const rows = await store.take(orgId, `upgrade:${providerId}:`);
  known.set(flag, "said");
  const moved: Array<{ family: string; from: string; to: string }> = [];
  for (const r of rows) {
    const family = r.key.slice(`upgrade:${providerId}:`.length);
    const to = newestOfFamily(catalog, family, listing.listed);
    if (!to) continue;
    await store.swap(orgId, `latest:${providerId}:${family}`, null, to);
    // A dated id is the same model as its alias: compare versions, not names.
    const was = catalog.parse(r.value)?.version;
    if (!was || versionText(was) !== versionText(catalog.parse(to)?.version ?? [])) moved.push({ family, from: r.value, to });
  }
  if (!moved.length) return;
  const sentence =
    moved.length === 1
      ? `Now using ${modelLabelOf(catalog, moved[0]!.to)}. Pin ${versionText(catalog.parse(moved[0]!.from)?.version ?? [])} in Configuration → AI if you want it back.`
      : `Now using ${moved.map((m) => modelLabelOf(catalog, m.to)).join(" and ")}. Pin an older version in Configuration → AI if you want it back.`;
  try {
    await notice(orgId, "upgrade", sentence);
  } catch (err) {
    // Not said: put the rows back so the next listing says it.
    known.delete(flag);
    for (const r of rows) await store.swap(orgId, r.key, null, r.value).catch(() => false);
    throw err;
  }
}

/**
 * The model a call sends: a family's latest becomes the newest listed model
 * of it, a pin stays exactly as named unless the live listing no longer has
 * it (then its family's newest, said once). Null when nothing of the family
 * is available to the key. What is said is never allowed to fail the call.
 */
export async function concreteModel(args: {
  orgId: string;
  providerId: string;
  key: string;
  catalog: AiModelCatalog;
  credentials: Record<string, unknown>;
  model: string;
  fresh?: boolean;
}): Promise<{ model: string } | { model: null; reason: string }> {
  const { catalog } = args;
  if (!catalog.familyOfLatest(args.model) && !catalog.parse(args.model)) return { model: args.model };
  const [listing] = await Promise.all([
    listingFor(args.key, catalog, args.credentials, { maxAgeMs: LISTING_REFRESH_MS, background: !args.fresh, fresh: args.fresh }),
    loadRedirects(args.key),
  ]);
  const r = resolveListedModel(catalog, args.model, listing.listed, { live: listing.live, redirects: redirectsFor(args.key) });
  if (r.model === null) return r;
  const said = async () => {
    if (r.latest) await noteLatest(args.orgId, args.providerId, catalog, r.latest, r.model);
    if (r.retired) await noteRetired(args.orgId, args.providerId, catalog, r.retired.from, r.model);
    await flushUpgradeNotice(args.orgId, args.providerId, catalog, listing);
  };
  await said().catch((err) => console.warn(`[core-ai] could not record the model ${r.model} for ${args.providerId}: ${(err as Error).message}`));
  return { model: r.model };
}

/** "Haiku · latest (5.5)" for a step on the AI page, from the listing this
 *  process already has; null when it has none or the id is not a family's. */
export function knownModelLabel(key: string, catalog: AiModelCatalog, model: string): string | null {
  if (!catalog.familyOfLatest(model) && !catalog.parse(model)) return null;
  return modelLabelOf(catalog, model, listings.get(key)?.listed ?? catalog.fallback, redirectsFor(key));
}

export function setModelListingForTest(opts: { clock?: (() => number) | null; store?: ModelStateStore | null; notice?: ModelNotice | null; reset?: boolean }): void {
  if (opts.clock !== undefined) now = opts.clock ?? (() => Date.now());
  if (opts.store !== undefined) store = opts.store ?? tenantStore;
  if (opts.notice !== undefined) notice = opts.notice ?? activityNotice;
  if (opts.reset) {
    listings.clear();
    flights.clear();
    known.clear();
    redirects.clear();
    redirectLoads.clear();
  }
}

/** Wait for every listing being read beside a call. */
export async function listingsSettledForTest(): Promise<void> {
  await Promise.all([...flights.values()]);
}

