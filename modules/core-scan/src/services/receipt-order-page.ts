/** A receipt read from the store's own order page, with no model.
 *
 *  A Shopify store's order email carries a link to the order's page, which
 *  Purchases keeps sealed and reads (#5461). The page names the order
 *  ("#36772") and every line in the store's words ("PETG 1.75mm - US / 10KG /
 *  white") with its quantity, and often its price. That is a better read of
 *  the order than a model's guess at the email, and it costs nothing: when the
 *  page answered, the free tiers read the email and the page fills the rest;
 *  a model is never asked. An email the model failed on used to sit in the
 *  inbox as "Couldn't be read" while its own store page knew every line.
 *
 *  Purchases is reached over its HTTP API, never its tables (receipt-order.ts
 *  says why), and the page arrives here as a summary: the link never does.
 */

import { orderPageLines, type OrderPageSummary } from "@cobblr/platform-contract/order-page-link";
import { apiFetch } from "@cobblr/platform-contract/self-api";
import { platform } from "@cobblr/platform-contract";
import { roundMoneyAmount } from "@cobblr/platform-contract/money";
import { cleanOrderRef, type ParsedReceipt, type ReceiptLine, type ReceiptResult } from "./receipt-shared.js";
import { detectOrderRef } from "./receipt-text.js";

/** The store's name from its host: "kingroon.com" → "Kingroon". */
export function storeNameOf(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  const main = labels.length > 2 && /^(shop|store|us|en)$/.test(labels[0]!) ? labels[1]! : labels[0] ?? host;
  return main.charAt(0).toUpperCase() + main.slice(1);
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The words that tell one variant from another: the last " / " part of the
 *  store's line name ("white", "Multicolor-1"). */
function variantWords(name: string): string[] {
  const parts = name.split(" / ");
  return words(parts.length > 1 ? parts[parts.length - 1]! : name);
}

/** How well a line someone read matches a page line: every variant word must
 *  be there, then the more shared words the better. 0 is no match. */
function matchScore(read: string, pageLine: string): number {
  const have = new Set(words(read));
  const variant = variantWords(pageLine);
  if (!variant.length || !variant.every((w) => have.has(w))) return 0;
  const page = words(pageLine);
  // A read line with words the variant does not have ("Multicolor-1" read
  // against the page's "Multicolor") is a worse match than the exact one.
  const extra = [...have].filter((w) => /^\d+$/.test(w) && !page.includes(w)).length;
  return page.filter((w) => have.has(w)).length - extra * 0.5;
}

/** Pair read lines with page lines, best matches first, each used once. */
export function matchPageLines(read: readonly string[], page: readonly string[]): Map<number, number> {
  const pairs: Array<{ r: number; p: number; score: number }> = [];
  read.forEach((r, ri) => page.forEach((p, pi) => {
    const score = matchScore(r, p);
    if (score > 0) pairs.push({ r: ri, p: pi, score });
  }));
  pairs.sort((a, b) => b.score - a.score);
  const out = new Map<number, number>();
  const used = new Set<number>();
  for (const { r, p } of pairs) {
    if (out.has(r) || used.has(p)) continue;
    out.set(r, p);
    used.add(p);
  }
  return out;
}

function amountsIn(line: string): number[] {
  return [...line.matchAll(/[$€£]\s?(\d[\d,]*\.\d{2})\b/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
}

/** The price the email prints for a line, when the page gave none: on the
 *  line that best matches it, or just below it (a store's email puts the
 *  title, the variant and the price on lines of their own). */
function priceInText(text: string | null, name: string): number | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    const score = matchScore(line, name);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  if (best < 0) return null;
  for (const line of lines.slice(best, best + 3)) {
    const amounts = amountsIn(line);
    if (amounts.length) return amounts[amounts.length - 1]!;
  }
  return null;
}

/** Rounded the way the currency is, or to cents when the page named none:
 *  only the number of decimals is taken from it. */
const rounded = (amount: number, currency: string | null) => roundMoneyAmount(amount, currency ?? "USD");

function lineOf(name: string, qty: number, unitPrice: number | null, currency: string | null): ReceiptLine {
  return {
    description: name,
    qty,
    unit_price: unitPrice,
    line_total: unitPrice != null ? rounded(unitPrice * qty, currency) : null,
    code: null,
    model: null,
    discount: null,
    weight: null,
    weight_unit: null,
  };
}

/** The receipt the page alone gives: the order's name, the store, and every
 *  line with its quantity and price. Null when the page named no lines. */
export function receiptFromOrderPage(page: OrderPageSummary, text: string | null): ParsedReceipt | null {
  const lines = orderPageLines(page);
  if (!lines.length) return null;
  const currency = lines.find((l) => l.currency)?.currency ?? null;
  const items = lines.map((l) => lineOf(l.name, l.qty, l.unit_price ?? priceInText(text, l.name), currency));
  const linesTotal = rounded(items.reduce((n, i) => n + (i.line_total ?? 0), 0), currency);
  return {
    vendor: storeNameOf(page.store),
    order_ref: cleanOrderRef(page.order_name),
    date: null,
    currency,
    total: null,
    seller: null,
    totals: null,
    expected_arrival: null,
    lines_total: linesTotal,
    lines_reconcile: null,
    items,
  };
}

/** A receipt the email's own text read, with the page filling what it left
 *  out: the order's name and the store, and each line named the way the
 *  store names it (matched by its variant words), so the order's parcels
 *  later find their lines. A page line the text missed is added. */
export function withOrderPage(receipt: ParsedReceipt, page: OrderPageSummary): ParsedReceipt {
  const lines = orderPageLines(page);
  const things = receipt.items.filter((i) => !i.kind);
  const matched = matchPageLines(things.map((i) => i.description), lines.map((l) => l.name));
  const named = new Map<ReceiptLine, string>();
  things.forEach((item, i) => {
    const p = matched.get(i);
    if (p != null) named.set(item, lines[p]!.name);
  });
  // A page line no read line matched is added only when every read line
  // found its page line: otherwise the read named it in other words, and
  // adding it would count it twice.
  const usedPage = new Set(matched.values());
  const missed = matched.size === things.length ? lines.filter((_, i) => !usedPage.has(i)).map((l) => lineOf(l.name, l.qty, l.unit_price, l.currency ?? receipt.currency)) : [];
  return {
    ...receipt,
    vendor: receipt.vendor ?? storeNameOf(page.store),
    order_ref: receipt.order_ref ?? cleanOrderRef(page.order_name),
    items: [...receipt.items.map((i) => (named.has(i) ? { ...i, description: named.get(i)! } : i)), ...missed],
  };
}

/** Read a receipt with its order page in hand: the free tiers first, never a
 *  model; what they read is filled from the page, and when they read nothing
 *  the page is the receipt. A page with no lines changes nothing: the read is
 *  the ordinary one. */
export async function readWithOrderPage(
  orgId: string,
  fileId: string,
  page: OrderPageSummary | null,
  read: (opts: { noModel?: boolean }) => Promise<ReceiptResult>,
): Promise<ReceiptResult> {
  if (!page || !orderPageLines(page).length) return read({});
  const result = await read({ noModel: true });
  if (result.ok) return { ...result, receipt: withOrderPage(result.receipt, page) };
  const file = await platform().files.read(orgId, fileId, "original").catch(() => null);
  const text = file && /^text\//.test(file.mimeType || "") ? new TextDecoder().decode(file.bytes) : null;
  const receipt = receiptFromOrderPage(page, text);
  if (!receipt) return read({});
  return { ok: true, receipt, method: "order-page", source: result.source ?? "text" };
}

/** What the store's page says about the order a kept receipt names, asked of
 *  Purchases by the order number the receipt's text prints. Null when the
 *  text names no order, Purchases is off, or no page waits on that number. */
export async function orderPageForReceipt(
  orgId: string,
  fileId: string,
  knownRef: string | null,
  api: { baseUrl: string; slug: string; token: string },
): Promise<OrderPageSummary | null> {
  let ref = knownRef;
  if (!ref) {
    const file = await platform().files.read(orgId, fileId, "original").catch(() => null);
    if (!file || !/^text\//.test(file.mimeType || "")) return null;
    ref = detectOrderRef(new TextDecoder().decode(file.bytes));
  }
  if (!ref) return null;
  try {
    const res = await apiFetch(`${api.baseUrl}/api/v1/orgs/${api.slug}/modules/purchases/order-pages/summary?order_number=${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${api.token}` },
    });
    if (!res.ok) return null;
    return ((await res.json()) as { order?: OrderPageSummary | null }).order ?? null;
  } catch {
    return null;
  }
}
