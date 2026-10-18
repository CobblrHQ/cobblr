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
// (the env-set-URL convention, docs/architecture/platform-spec.md §14.1).
// EGRESS-FILE: operator-configured - the hosted identify address is the operator's setting
import { nameReadsAsProse } from "./item-name.js";
import { parseProductRegion } from "./image-ops.js";
import { parseListing } from "./listing-evidence.js";
import type { PhotoIdentity } from "./enrich-photo.js";
import { seenCountOf, seenDistinctOf } from "./seen-count.js";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { envNumber } from "@cobblr/platform-contract/env-number";
import type { CoreScanDB } from "../db.js";

const TIMEOUT_MS = 120_000; // the engine can take most of 90s on a cold vision call

// The kernel's AI-status route needs this same answer to avoid telling a
// visitor "AI isn't connected" on a deployment that identifies things fine,
// so the predicate lives in the contract and both sides import it.
export {
  hostedIdentifyEnabled,
  hostedIdentifyReach,
  identifyAppsAllowed,
  setIdentifyOrgLookup,
  workspaceInIdentifyScope,
} from "@cobblr/platform-contract/hosted-identify";
import { hostedIdentifyReach } from "@cobblr/platform-contract/hosted-identify";

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
  const cap = envNumber("COBBLR_IDENTIFY_PER_WORKSPACE_DAY", 0);
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
/** Why the hosted path did not answer, when it did not: off (not
 *  configured), scope, plan, allowance (the workspace's or the person's
 *  daily tier), unreachable. The tenant path runs next either way; a
 *  photo that ends up unnamed carries this reason, so the drawer can say
 *  "used up for today" instead of a silent nothing (2026-09-24). */
export type HostedDegrade = "off" | "scope" | "plan" | "allowance" | "unreachable";

export async function hostedIdentify(opts: Parameters<typeof hostedIdentifyWhy>[0]): Promise<HostedAnswer | null> {
  return (await hostedIdentifyWhy(opts)).answer;
}

export async function hostedIdentifyWhy(opts: {
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
}): Promise<{ answer: HostedAnswer | null; degraded?: HostedDegrade; queued?: HostedQueued }> {
  // The same answer /ai-status gives, so what a person is promised and what
  // the scan does cannot disagree (#3867).
  const reach = await hostedIdentifyReach(opts.orgId);
  if (!reach.available) {
    if (reach.why === "scope") console.log(`[hosted-identify] workspace ${opts.orgId} is outside COBBLR_IDENTIFY_APPS — degrading`);
    return { answer: null, degraded: reach.why };
  }
  const url = process.env.COBBLR_IDENTIFY_URL!.trim();
  if (!(await entitlement(opts.orgId, opts.userId))) {
    console.log(`[hosted-identify] plan says no for ${opts.userId ?? "workspace " + opts.orgId} today — degrading`);
    return { answer: null, degraded: "plan" };
  }
  const allowance = await workspaceIdentifyAllowance(opts.orgId);
  if (!allowance.ok) {
    console.log(`[hosted-identify] workspace ${opts.orgId} over its daily allowance (${allowance.cap}) — degrading`);
    return { answer: null, degraded: "allowance" };
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
      // A 429 is the edge's per-person daily tier: the allowance, said so.
      return { answer: null, degraded: res.status === 429 ? "allowance" : "unreachable" };
    }
    const body = (await res.json()) as HostedAnswer & { cached?: boolean; status?: unknown; job_id?: unknown; message?: unknown };
    // Accepted, not answered: every engine the service has was busy or out,
    // so it queued the photo and will answer later (barcode-intelligence #43).
    // That is not a failure and not "unidentified": the caller says "back
    // shortly" and collects the job (hostedIdentifyJob). It will cost an
    // engine call when it runs, so it is metered as one now.
    if (res.status === 202 && body?.status === "queued" && typeof body.job_id === "string" && body.job_id) {
      meterIdentify({ orgId: opts.orgId, kind: "identify.call", userId: opts.userId });
      console.log(`[hosted-identify] queued as ${body.job_id}: every engine is busy; collecting it later`);
      return { answer: null, queued: { jobId: body.job_id, message: typeof body.message === "string" ? body.message : HOSTED_QUEUED_WORDS } };
    }
    if (body?.cached === true) {
      await refundWorkspaceIdentify(opts.orgId);
      meterIdentify({ orgId: opts.orgId, kind: "identify.refund", userId: opts.userId });
    } else {
      meterIdentify({ orgId: opts.orgId, kind: "identify.call", userId: opts.userId });
    }
    return { answer: body && typeof body.kind === "string" ? body : null };
  } catch (err) {
    console.log(`[hosted-identify] unreachable (${(err as Error).message}) — degrading`);
    return { answer: null, degraded: "unreachable" };
  }
}

/** A photo the service accepted and will answer later: its job, and the
 *  service's own words for the wait. */
export interface HostedQueued {
  jobId: string;
  message: string;
}

/** What the row says while a queued identify waits. */
export const HOSTED_QUEUED_WORDS = "Identifying. Back shortly.";
/** ...and while a queued receipt read waits. */
export const HOSTED_RECEIPT_QUEUED_WORDS = "Reading the receipt. Back shortly.";

/** Where a queued identify has got to. `lost` is a job the service no longer
 *  knows (it expired, or the service was rebuilt): asking again will not help. */
export type HostedJobState =
  | { state: "queued" }
  | { state: "done"; answer: HostedAnswer }
  | { state: "failed"; message: string }
  | { state: "lost" }
  | { state: "unreachable" };

/** Collect a queued identify (GET /v1/identify/jobs/:id). Never throws: a
 *  service that cannot be reached right now is asked again later. Free on
 *  the service's side, so nothing is metered. */
export async function hostedIdentifyJob(jobId: string): Promise<HostedJobState> {
  const url = process.env.COBBLR_IDENTIFY_URL?.trim();
  if (!url) return { state: "unreachable" };
  try {
    const key = process.env.COBBLR_IDENTIFY_KEY?.trim();
    const res = await fetch(`${url.replace(/\/+$/, "")}/v1/identify/jobs/${encodeURIComponent(jobId)}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { state: "lost" };
    if (!res.ok) return { state: "unreachable" };
    const body = (await res.json()) as HostedAnswer & { status?: unknown; message?: unknown };
    if (body?.status === "done" && typeof body.kind === "string") return { state: "done", answer: body };
    if (body?.status === "failed") return { state: "failed", message: typeof body.message === "string" ? body.message : "" };
    return { state: "queued" };
  } catch (err) {
    console.log(`[hosted-identify] job ${jobId} unreachable (${(err as Error).message}); asking again later`);
    return { state: "unreachable" };
  }
}

/** The service's item package → the PhotoIdentity shape every consumer of
 *  identifyImage already reads. The field names match by construction (the
 *  endpoint mirrors core's reply keys); this mapper is where that contract is
 *  enforced rather than assumed. */
export function toPhotoIdentity(item: Record<string, unknown>): PhotoIdentity | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = str(item.name);
  // A description of the photo is no name (#6100): the caller reads the
  // label instead (identifyPhoto), the same rule the tenant reply follows.
  if (!name || nameReadsAsProse(name)) return null;
  const et = str(item.entity_type);
  const items = Array.isArray(item.items) ? (item.items as Array<{ name?: unknown; brand?: unknown; qty?: unknown }>) : [];
  const individuals = items
    .map((i) => {
      const n = str(i.name);
      if (!n) return null;
      return { name: n, brand: str(i.brand), qty: seenCountOf(i.qty) };
    })
    .filter((x): x is { name: string; brand: string | null; qty: number } => x !== null);
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
    // The same two reads a tenant AI's reply carries, whenever the hosted
    // service sends them: a listing screenshot's photo box and what the
    // listing printed about the sale (#3853).
    product_photo_box: parseProductRegion({ box: (item as { product_photo_box?: unknown }).product_photo_box }),
    listing: parseListing((item as { listing?: unknown }).listing),
    distinct: individuals.length >= 2 ? individuals.length : seenDistinctOf(item.distinct),
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
