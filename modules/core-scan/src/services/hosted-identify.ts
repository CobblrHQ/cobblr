// The hosted identify client — core's door to BIdb's POST /v1/identify
// (business-models doc 25; the endpoint's contract is barcode-intelligence
// docs/identify.md).
//
// Ships dark: nothing happens unless COBBLR_IDENTIFY_URL is set (the
// bidbEnabled() convention — presence of config is the whole switch). When it
// is set, the scan pipeline's vision steps go here FIRST and fall through to
// the tenant's own AI on any failure, so a workspace with BYO AI loses nothing
// and a workspace with none — the try sandbox — gains the whole flow.
//
// Deliberately NOT a platform().ai provider. The identify prompt lives in
// core-ai, which this module cannot import (module isolation), and the provider
// seam resolves per-workspace connections this tier may not have. The endpoint
// owns its own identify prompt (the drift lesson is written on both ends);
// the ONE prompt core-scan sends is its own receipt prompt, whose recorded
// fixtures pin its exact text.
//
// Operator-configured internal service ⇒ plain fetch, strict-egress-safe
// (the env-set-URL convention, CLAUDE.md §14.1).
import type { PhotoIdentity } from "./enrich-photo.js";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";

const TIMEOUT_MS = 120_000; // the engine can take most of 90s on a cold vision call

// The kernel's AI-status route needs this same answer to avoid telling a
// visitor "AI isn't connected" on a deployment that identifies things fine,
// so the predicate lives in the contract and both sides import it.
export { hostedIdentifyEnabled } from "@cobblr/platform-contract/hosted-identify";

/** One install key serves MANY workspaces (every sandbox on the try box; every
 *  customer on the hosted product), so the edge's per-key cap cannot give each
 *  workspace its own allowance - one visitor could drain the box. This counter
 *  is the per-workspace half; the key cap stays the aggregate backstop.
 *  0/unset = uncapped (a keyed self-host is spending its own quota).
 *
 *  It lives in the TENANT DATABASE, not in memory. The first version was a Map,
 *  with "a restart resets, accepted" - true of an hour-long sandbox, and false
 *  the moment the same code ran on the hosted product: a deploy handed every
 *  workspace a fresh N, and with two api processes on one database (the canary
 *  channel, every rolling deploy) the cap was per process, so the advertised N
 *  was enforced as 2N. A number you print on a pricing page has to be the number
 *  you enforce. */
export interface IdentifyUsageStore {
  /** Spend one unit for (workspace, UTC day) if under `cap`. True = granted.
   *  Must be atomic across processes: two callers racing for the last unit
   *  get one true and one false, never two trues. */
  claim(orgId: string, day: string, cap: number): Promise<boolean>;
  /** Hand one unit back. Never below zero. */
  refund(orgId: string, day: string): Promise<void>;
}

async function tenantDb(orgId: string): Promise<Kysely<CoreScanDB>> {
  return (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
}

/** The wired store. One statement per operation, so the guard and the
 *  increment happen under the same row lock and a second process sees the
 *  result of the first. Takes its db getter so the concurrency test can point
 *  this exact code at a real Postgres without booting the platform. */
export function makePostgresIdentifyUsageStore(
  getDb: (orgId: string) => Promise<Kysely<CoreScanDB>>,
): IdentifyUsageStore {
  return {
  async claim(orgId, day, cap) {
    const db = await getDb(orgId);
    const r = await sql<{ n: number }>`
      insert into core_scan_identify_usage (day, n) values (${day}::date, 1)
      on conflict (day) do update set n = core_scan_identify_usage.n + 1
        where core_scan_identify_usage.n < ${cap}
      returning n`.execute(db);
    return r.rows.length > 0;
  },
  async refund(orgId, day) {
    const db = await getDb(orgId);
    await sql`update core_scan_identify_usage set n = greatest(n - 1, 0) where day = ${day}::date`.execute(db);
  },
  };
}
const postgresIdentifyUsageStore = makePostgresIdentifyUsageStore(tenantDb);

/** TESTS ONLY. The behaviour the allowance layer adds on top of a store (cap 0
 *  = uncapped, UTC-day keying, refund, failing open) is testable without a
 *  database; the store's own promise (atomicity) is tested against Postgres. */
export function inMemoryIdentifyUsageStore(): IdentifyUsageStore & { count(orgId: string, day: string): number } {
  const m = new Map<string, number>();
  const k = (o: string, d: string) => `${o}|${d}`;
  return {
    async claim(orgId, day, cap) {
      const n = m.get(k(orgId, day)) ?? 0;
      if (n >= cap) return false;
      m.set(k(orgId, day), n + 1);
      return true;
    },
    async refund(orgId, day) {
      m.set(k(orgId, day), Math.max(0, (m.get(k(orgId, day)) ?? 0) - 1));
    },
    count: (orgId, day) => m.get(k(orgId, day)) ?? 0,
  };
}

/** Which workspaces get hosted identification at all.
 *
 *  `COBBLR_IDENTIFY_APPS` unset or `*` = every workspace on this deployment
 *  (the try box: every sandbox). A comma list of managed-app ids (`yarn`, or
 *  `yarn,lego`) = only workspaces locked into one of those apps; a platform
 *  workspace on the same box gets nothing and degrades to its own AI path.
 *  That is what lets the hosted product hand a free daily allowance to the
 *  yarn app without handing it to everyone who signs up for anything.
 *
 *  Per USER, in practice: a managed-app workspace is one person, so the
 *  per-workspace counter below is a per-person counter for exactly the
 *  workspaces this scope admits. */
export function identifyAppsAllowed(): "*" | Set<string> {
  const raw = (process.env.COBBLR_IDENTIFY_APPS ?? "*").trim();
  if (!raw || raw === "*") return "*";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

type OrgLookup = (orgId: string) => Promise<{ app_mode: { app: string } | null } | null>;
const platformOrgLookup: OrgLookup = (orgId) => platform().orgs.get(orgId);
let orgLookup: OrgLookup = platformOrgLookup;
/** Swap the workspace lookup (tests). `null` restores the platform one. */
export function setIdentifyOrgLookup(fn: OrgLookup | null): void {
  orgLookup = fn ?? platformOrgLookup;
}

/** Fails CLOSED. This is entitlement, not accounting: a workspace we cannot
 *  place must not spend the shared key. (The allowance counter below fails
 *  open, because there the edge's own cap still bounds the spend; here nothing
 *  would.) */
export async function workspaceInIdentifyScope(orgId: string): Promise<boolean> {
  const allowed = identifyAppsAllowed();
  if (allowed === "*") return true;
  try {
    const org = await orgLookup(orgId);
    const app = org?.app_mode?.app;
    return !!app && allowed.has(app);
  } catch (err) {
    console.error(`[hosted-identify] could not place workspace ${orgId} - refusing:`, (err as Error).message);
    return false;
  }
}

/** The hosted plan's say.
 *
 *  Open core knows one number: the per-workspace cap below, which is a
 *  self-hoster capping spend on their own key. Who a PERSON is, what their
 *  plan allows per day, and what happens when they hold three workspaces are
 *  hosted-product questions, and they are answered in the cloud overlay
 *  through the entitlement seam core already has - the same door
 *  `workspaces.create` goes through. No guard registered → allowed, which is
 *  exactly right for a self-host. A guard that throws is treated the same
 *  way, matching `checkEntitlement`'s own contract. */
type IdentifyEntitlement = (orgId: string, userId: string | null | undefined) => Promise<boolean>;
const platformIdentifyEntitlement: IdentifyEntitlement = async (orgId, userId) => {
  try {
    const v = await platform().entitlements.check({ orgId, userId: userId ?? undefined, feature: "identify.daily" });
    return v.allow;
  } catch {
    return true;
  }
};
let entitlement: IdentifyEntitlement = platformIdentifyEntitlement;
/** Swap the plan check (tests). `null` restores the platform seam. */
export function setIdentifyEntitlement(fn: IdentifyEntitlement | null): void {
  entitlement = fn ?? platformIdentifyEntitlement;
}

/** What core tells the overlay after the fact: one `identify.call` per answer
 *  the service actually produced, and one `identify.refund` per answer that
 *  came from cache and so cost nothing. The overlay's guard claims a unit
 *  BEFORE the call (it cannot know a cache hit is coming), and the refund is
 *  how it hands that unit back - the same shape as the workspace counter
 *  below. No sink registered → dropped. Never throws. */
type IdentifyMeter = (e: { orgId: string; kind: "identify.call" | "identify.refund"; userId?: string | null }) => void;
const platformIdentifyMeter: IdentifyMeter = (e) => {
  try {
    platform().metering.record({ orgId: e.orgId, kind: e.kind, quantity: 1, meta: { userId: e.userId ?? null } });
  } catch {
    /* no platform (unit tests) or no sink: nothing to record */
  }
};
let meterIdentify: IdentifyMeter = platformIdentifyMeter;
/** Swap the meter (tests). `null` restores the platform seam. */
export function setIdentifyMeter(fn: IdentifyMeter | null): void {
  meterIdentify = fn ?? platformIdentifyMeter;
}

let store: IdentifyUsageStore = postgresIdentifyUsageStore;
/** Swap the store (tests). `null` restores the Postgres one. */
export function setIdentifyUsageStore(s: IdentifyUsageStore | null): void {
  store = s ?? postgresIdentifyUsageStore;
}

/** UTC calendar day, the bucket every counter here keys on. */
export function identifyUsageDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function workspaceIdentifyAllowance(
  orgId: string,
  now = Date.now(),
): Promise<{ ok: boolean; cap: number }> {
  const cap = Number(process.env.COBBLR_IDENTIFY_PER_WORKSPACE_DAY ?? 0);
  if (!cap) return { ok: true, cap: 0 };
  try {
    return { ok: await store.claim(orgId, identifyUsageDay(now), cap), cap };
  } catch (err) {
    // Fail OPEN. A counter that cannot be read must not switch identification
    // off for a whole workspace; the edge's per-key cap still bounds the spend.
    console.error(`[hosted-identify] allowance store failed for ${orgId} - allowing:`, (err as Error).message);
    return { ok: true, cap };
  }
}

/** A cached answer costs the service nothing, so it costs the workspace
 *  nothing. The allowance is spent BEFORE the call (we cannot know the answer
 *  will come from cache), so a hit hands it back - without this, re-scanning
 *  the demo items would burn a sandbox's allowance on answers that were free,
 *  while the edge's own counter (which refunds) said the opposite. */
export async function refundWorkspaceIdentify(orgId: string, now = Date.now()): Promise<void> {
  try {
    await store.refund(orgId, identifyUsageDay(now));
  } catch (err) {
    console.error(`[hosted-identify] refund failed for ${orgId}:`, (err as Error).message);
  }
}

export interface HostedReceipt {
  vendor: string | null;
  order_ref: string | null;
  date: string | null;
  currency: string | null;
  total: number | null;
  items: Array<{ description: string; qty: number; unit_price: number | null; line_total: number | null; discount: number | null }>;
}

export interface HostedAnswer {
  kind: "item" | "receipt" | "person" | "unidentifiable";
  source: string | null;
  item?: Record<string, unknown>;
  receipt?: HostedReceipt;
}

/** Ask the service. Null on ANY failure — disabled, over allowance, network,
 *  non-200, unparseable — so every caller degrades to the tenant-AI path it
 *  already had. A hosted outage must never be worse than never having it. */
export async function hostedIdentify(opts: {
  orgId: string;
  imageB64: string;
  barcode?: string | null;
  receiptPrompt?: string;
  /** The signed-in person driving this scan, when a request started it. The
   *  hosted plan meters per person; detached work (retry sweeps, email
   *  ingest) has none and is metered against the workspace instead. */
  userId?: string | null;
  /** The visitor driving this scan, when a request started it. Forwarded so
   *  the edge can run its per-person daily tier — which is what closes the
   *  burn-the-allowance-then-start-a-fresh-sandbox loophole that a
   *  per-workspace counter alone cannot. Detached work with no visitor (retry
   *  sweeps, email ingest) sends nothing and rides the key cap. */
  visitorIp?: string | null;
}): Promise<HostedAnswer | null> {
  const url = process.env.COBBLR_IDENTIFY_URL?.trim();
  if (!url) return null;
  if (!(await workspaceInIdentifyScope(opts.orgId))) {
    console.log(`[hosted-identify] workspace ${opts.orgId} is outside COBBLR_IDENTIFY_APPS — degrading`);
    return null;
  }
  if (!(await entitlement(opts.orgId, opts.userId))) {
    console.log(`[hosted-identify] plan says no for ${opts.userId ?? "workspace " + opts.orgId} today — degrading`);
    return null;
  }
  const allowance = await workspaceIdentifyAllowance(opts.orgId);
  if (!allowance.ok) {
    console.log(`[hosted-identify] workspace ${opts.orgId} over its daily allowance (${allowance.cap}) — degrading`);
    return null;
  }
  try {
    const key = process.env.COBBLR_IDENTIFY_KEY?.trim();
    const res = await fetch(`${url.replace(/\/+$/, "")}/v1/identify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(opts.visitorIp ? { "x-cobblr-visitor-ip": opts.visitorIp } : {}),
      },
      body: JSON.stringify({
        image: opts.imageB64,
        ...(opts.barcode ? { barcode: opts.barcode } : {}),
        ...(opts.receiptPrompt ? { receipt_prompt: opts.receiptPrompt } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.log(`[hosted-identify] ${res.status} — degrading to the tenant path`);
      return null;
    }
    const body = (await res.json()) as HostedAnswer & { cached?: boolean };
    if (body?.cached === true) {
      await refundWorkspaceIdentify(opts.orgId);
      meterIdentify({ orgId: opts.orgId, kind: "identify.refund", userId: opts.userId });
    } else {
      meterIdentify({ orgId: opts.orgId, kind: "identify.call", userId: opts.userId });
    }
    return body && typeof body.kind === "string" ? body : null;
  } catch (err) {
    console.log(`[hosted-identify] unreachable (${(err as Error).message}) — degrading`);
    return null;
  }
}

/** The service's item package → the PhotoIdentity shape every consumer of
 *  identifyImage already reads. The field names match by construction (the
 *  endpoint mirrors core's reply keys); this mapper is where that contract is
 *  enforced rather than assumed. */
export function toPhotoIdentity(item: Record<string, unknown>): PhotoIdentity | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = str(item.name);
  if (!name) return null;
  const et = str(item.entity_type);
  const items = Array.isArray(item.items) ? (item.items as Array<{ name?: unknown; brand?: unknown; qty?: unknown }>) : [];
  const individuals = items
    .map((i) => {
      const n = str(i.name);
      if (!n) return null;
      const qty = Number(i.qty);
      return { name: n, brand: str(i.brand), qty: Number.isFinite(qty) && qty >= 1 ? Math.round(qty) : 1 };
    })
    .filter((x): x is { name: string; brand: string | null; qty: number } => x !== null);
  const distinct = Number(item.distinct);
  return {
    name,
    brand: str(item.brand),
    category: str(item.category),
    color: str(item.color),
    entityType: et === "asset" || et === "part" ? et : null,
    series: str(item.series),
    confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
    barcode: str(item.barcode),
    serial_number: str(item.serial_number),
    observations: str(item.observations) ?? "",
    product_photo_box: null,
    distinct: individuals.length >= 2 ? individuals.length : Number.isFinite(distinct) && distinct >= 1 ? distinct : 1,
    individuals,
  };
}

/** A receipt classification, expressed as the identity shape the pipeline's
 *  existing receipt detector fires on — looksLikeReceiptPhoto reads
 *  observations naming a receipt as the subject, so this routes the row into
 *  the receipt flow the same way a tenant-AI identification would. */
export function receiptAsIdentity(): PhotoIdentity {
  return {
    name: "Receipt",
    brand: null,
    category: "receipt",
    color: null,
    entityType: null,
    series: null,
    confidence: 0.9,
    barcode: null,
    serial_number: null,
    observations: "A printed purchase receipt or invoice, not an item you own.",
    product_photo_box: null,
    distinct: 1,
    individuals: [],
  };
}

/** The receipt branch's answer, as the raw "model reply" string the existing
 *  parser consumes — the endpoint returns core's own receipt schema, so a
 *  stringify IS the shim, and shapeReceipt never learns which engine answered. */
export function receiptAsModelReply(receipt: HostedReceipt): string {
  return JSON.stringify(receipt);
}
