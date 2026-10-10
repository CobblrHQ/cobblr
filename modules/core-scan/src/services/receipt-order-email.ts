// A store's order confirmation email, read with no model. Shopify's layout
// (and the stores that copy it) prints each line as its title with "× N",
// the variant under it, then the line's price:
//
//   KINGROON PETG Filament 1.75mm × 1
//   US / 10KG / white
//   $80.30
//
// The till parser reads that as a price under the variant ("US /"), so an
// order email went to a model, and failed with it. Here each block is one
// line named the store's way, "TITLE - variant", the same form the order
// page gives, and the lines must add up to the email's own subtotal (or its
// total when it prints none): arithmetic that does not reconcile returns null
// and the next tier reads it. The order-level discount stays in the totals,
// where the text reader puts it.

import { parseReceiptTotals, type ReceiptTotals } from "@cobblr/platform-contract/receipt-totals";
import { buildReceipt, enrichReceiptFromText, type ParsedReceipt } from "./receipt-shared.js";
import { detectDate, detectOrderRef } from "./receipt-text.js";

const TIMES = /\s+[×xX]\s*(\d{1,3})\s*$/;
const PRICE_ONLY = /^(?:[$€£¥]\s*)?\d{1,3}(?:,\d{3})*\.\d{2}(?:\s*[A-Z]{3})?(?:\s+(?:[$€£¥]\s*)?\d{1,3}(?:,\d{3})*\.\d{2}(?:\s*[A-Z]{3})?)?$/;
const MONEY = /[-−]?\s*[$€£¥]?\s*(\d{1,3}(?:,\d{3})*\.\d{2})/g;
/** A line that prints a price: a currency sign before digits, or an amount
 *  ending it. Not "1.75mm" in a product's name. */
const PRICED = /[$€£¥]\s*\d|\d\.\d{2}\s*(?:[A-Z]{3})?\s*$/;
const SUBTOTAL = /^sub[\s-]?total\b/i;
const TOTAL = /^total\b/i;
const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

function decoded(s: string): string {
  return s
    .replace(/&times;/gi, "×")
    .replace(/&nbsp;| /gi, " ")
    .replace(/&amp;/gi, "&")
    // A forwarded email's plain part marks bold with asterisks: "*$230.66 USD*".
    .replace(/^\*+|\*+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The last amount a line prints: a sale price after its struck-out one. */
function lastAmount(line: string): number | null {
  const all = [...line.matchAll(MONEY)];
  const m = all[all.length - 1];
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

function currencyOf(text: string): string | null {
  const code = text.match(/\b(USD|EUR|GBP|CAD|AUD|JPY)\b/);
  if (code) return code[1]!;
  const sym = text.match(/[$€£¥]/);
  return sym ? (CURRENCY[sym[0]] ?? null) : null;
}

/** The order's totals, read from its own block (Subtotal to Total) with each
 *  label joined to the amount a forwarded plain part prints under it. Read
 *  over the whole text, a delivery estimate's "Nov 12" became $12 shipping
 *  and the discount, its amount a line below, was lost. */
function footTotals(lines: string[]): ReceiptTotals | null {
  const from = lines.findIndex((l) => SUBTOTAL.test(l));
  if (from < 0) return null;
  const foot: string[] = [];
  for (let i = from; i < lines.length; i++) {
    let line = lines[i]!;
    const next = lines[i + 1];
    if (!PRICED.test(line) && next && PRICED.test(next) && !/[a-z]/i.test(next.replace(/\b[A-Z]{3}\b/, ""))) {
      line = `${line} ${next}`;
      i++;
    }
    const isTotal = TOTAL.test(line);
    foot.push(isTotal ? line.replace(TOTAL, "Total charged") : line);
    if (isTotal) break;
  }
  return parseReceiptTotals(foot.join("\n"));
}

interface Block {
  title: string;
  qty: number;
  variants: string[];
}

/** The order email's lines, or null when the text is not that layout or its
 *  lines do not add up to what it says they cost. */
export function parseOrderEmail(text: string): ParsedReceipt | null {
  const lines = text.split(/\r?\n/).map(decoded).filter(Boolean);
  const items: Array<{ description: string; qty: number; unit_price: number; line_total: number }> = [];
  let block: Block | null = null;
  let before: string | null = null;
  let subtotal: number | null = null;
  let total: number | null = null;
  // A forwarded plain part prints a totals label on its own line and the
  // amount on the next: "Subtotal" then "*$256.28*".
  let awaiting: "subtotal" | "total" | null = null;
  for (const line of lines) {
    if (awaiting) {
      const amount = PRICED.test(line) ? lastAmount(line) : null;
      if (awaiting === "subtotal") subtotal ??= amount;
      else total ??= amount;
      if (awaiting === "total") break;
      awaiting = null;
      continue;
    }
    if (SUBTOTAL.test(line)) {
      const amount = lastAmount(line);
      if (amount === null) awaiting = "subtotal";
      subtotal ??= amount;
      block = null;
      continue;
    }
    if (TOTAL.test(line)) {
      const amount = lastAmount(line);
      if (amount === null) {
        awaiting = "total";
        continue;
      }
      total ??= amount;
      break;
    }
    if (subtotal !== null) continue;
    const times = TIMES.exec(line);
    if (times && /[a-z]/i.test(line.slice(0, times.index))) {
      const words = line.slice(0, times.index).trim();
      const qty = Number(times[1]);
      // "TITLE" over "variant × N": the variant carries the count.
      block = before && / \/ /.test(words) && !block ? { title: before, qty, variants: [words] } : { title: words, qty, variants: [] };
      before = null;
      continue;
    }
    if (block && PRICE_ONLY.test(line)) {
      const lineTotal = lastAmount(line);
      if (lineTotal === null) return null;
      const variant = block.variants.join(" / ");
      items.push({
        description: variant ? `${block.title} - ${variant}` : block.title,
        qty: block.qty,
        unit_price: Math.round((lineTotal / block.qty) * 100) / 100,
        line_total: lineTotal,
      });
      block = null;
      before = null;
      continue;
    }
    if (block) {
      if (!PRICED.test(line) && /[a-z0-9]/i.test(line) && block.variants.length < 2) block.variants.push(line);
      continue;
    }
    before = !PRICED.test(line) && /[a-z]/i.test(line) ? line : null;
  }
  if (!items.length) return null;
  const expected = subtotal ?? total;
  if (expected === null) return null;
  const sum = Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100;
  if (Math.abs(sum - expected) > Math.max(0.02, items.length * 0.01)) return null;
  const receipt = buildReceipt({
    vendor: null,
    order_ref: detectOrderRef(text),
    date: detectDate(text),
    currency: currencyOf(text),
    total: total ?? subtotal,
    totals: footTotals(lines),
    items,
  });
  return receipt ? enrichReceiptFromText(receipt, text) : null;
}
