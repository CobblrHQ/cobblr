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

const TIMEOUT_MS = 120_000; // the engine can take most of 90s on a cold vision call

export const hostedIdentifyEnabled = (): boolean => Boolean(process.env.COBBLR_IDENTIFY_URL?.trim());

/** One install key serves MANY sandboxes on the try box, so the edge's per-key
 *  cap cannot give each workspace its own allowance — one visitor could drain
 *  the box. This counter is the per-workspace half; the key cap stays the
 *  aggregate backstop. 0/unset = uncapped (a keyed self-host is spending its
 *  own quota as it pleases). In-memory UTC days: a restart resets, accepted. */
const used = new Map<string, { day: number; n: number }>();
export function workspaceIdentifyAllowance(orgId: string, now = Date.now()): { ok: boolean; cap: number } {
  const cap = Number(process.env.COBBLR_IDENTIFY_PER_WORKSPACE_DAY ?? 0);
  if (!cap) return { ok: true, cap: 0 };
  const day = Math.floor(now / 86_400_000);
  let s = used.get(orgId);
  if (!s || s.day !== day) {
    s = { day, n: 0 };
    used.set(orgId, s);
  }
  if (s.n >= cap) return { ok: false, cap };
  s.n++;
  return { ok: true, cap };
}

/** A cached answer costs the service nothing, so it costs the workspace
 *  nothing. The allowance is spent BEFORE the call (we cannot know the answer
 *  will come from cache), so a hit hands it back - without this, re-scanning
 *  the demo items would burn the sandbox's 10 on answers that were free, while
 *  the edge's own counter (which refunds) said the opposite. Never below zero. */
export function refundWorkspaceIdentify(orgId: string, now = Date.now()): void {
  const day = Math.floor(now / 86_400_000);
  const s = used.get(orgId);
  if (s && s.day === day && s.n > 0) s.n--;
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
  /** The visitor driving this scan, when a request started it. Forwarded so
   *  the edge can run its per-person daily tier — which is what closes the
   *  burn-the-allowance-then-start-a-fresh-sandbox loophole that a
   *  per-workspace counter alone cannot. Detached work with no visitor (retry
   *  sweeps, email ingest) sends nothing and rides the key cap. */
  visitorIp?: string | null;
}): Promise<HostedAnswer | null> {
  const url = process.env.COBBLR_IDENTIFY_URL?.trim();
  if (!url) return null;
  const allowance = workspaceIdentifyAllowance(opts.orgId);
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
    if (body?.cached === true) refundWorkspaceIdentify(opts.orgId);
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
