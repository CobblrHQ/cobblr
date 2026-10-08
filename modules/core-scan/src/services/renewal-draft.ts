import { addInterval } from "@cobblr/platform-contract/interval";
import type { ParsedReceipt } from "./receipt-shared.js";
import { isoDate } from "./receipt-shared.js";

export interface ReceiptRenewal { billing_cycle?: "Monthly" | "Yearly" | "Custom"; custom_months?: number; next_date?: string; period_start?: string }
export function readRenewalPeriod(text: string): ReceiptRenewal {
  const out: ReceiptRenewal = {};
  const custom = /\bevery\s+(\d+)\s+months?\b/i.exec(text);
  const monthly = /\bmonthly\b/i.test(text);
  const yearly = /\b(annual|annually|yearly)\b/i.test(text);
  if (custom && Number(custom[1]) > 0 && Number(custom[1]) <= 1000) { out.billing_cycle = "Custom"; out.custom_months = Number(custom[1]); }
  else if (monthly !== yearly) out.billing_cycle = monthly ? "Monthly" : "Yearly";
  const next = /\b(?:next\s+(?:renewal|payment|billing\s+date)|renews(?:\s+on)?|expires(?:\s+on)?)\s*[:\-]?\s*([^\n]+)/i.exec(text);
  if (next) out.next_date = isoDate(next[1]!) ?? undefined;
  const period = /\b(?:coverage|service\s+period|billing\s+period)\s*:?\s*(\d{4}-\d{2}-\d{2})\s*(?:to|through|[-–])\s*(\d{4}-\d{2}-\d{2})/i.exec(text);
  if (period) { out.period_start = isoDate(period[1]!) ?? undefined; out.next_date ??= isoDate(period[2]!) ?? undefined; }
  return out;
}

export function renewalDraft(receipt: ParsedReceipt) {
  const period = receipt.renewal ?? {};
  const start = period.period_start ?? receipt.date;
  const next = period.next_date ?? (start && period.billing_cycle ? addInterval(new Date(start + "T12:00:00Z"), period.billing_cycle === "Custom" ? period.custom_months ?? 1 : 1, period.billing_cycle === "Yearly" ? "year" : "month").toISOString().slice(0, 10) : null);
  return { name: receipt.items[0]?.description ?? receipt.vendor ?? "Renewal", vendor: receipt.vendor,
    cost: receipt.total == null ? null : { amount: receipt.total, currency: receipt.currency ?? null },
    billing_cycle: period.billing_cycle ?? null, custom_months: period.custom_months ?? null,
    next_date: next, period_start: start, quantity: receipt.items[0]?.qty ?? null, review_required: true as const };
}
