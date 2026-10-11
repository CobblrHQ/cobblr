import { toCsv } from "@cobblr/platform-contract/csv";
import { fieldCurrency, formatStoredMoney, roundMoneyAmount, totalOfLines, type LinesTotal } from "@cobblr/platform-contract/money";

interface InvoiceOrder {
  id: string;
  order_number: string | null;
  customer_name: string | null;
  order_date: string | null;
  paid?: boolean;
  metadata?: Record<string, unknown>;
  items: Array<{ description: string | null; qty: string | number; unit_price: string | number | null; metadata?: Record<string, unknown> }>;
}

/** What an order's lines add up to: the one sum the order page, the invoice
 *  and the CSV all read, so none of them calls a partial total complete. */
export function orderTotal(items: ReadonlyArray<{ qty: string | number; unit_price: string | number | null }>, currency: string): LinesTotal {
  return totalOfLines(items.map((it) => ({ qty: it.qty, price: it.unit_price })), currency);
}

function invoice(order: InvoiceOrder, fallbackCurrency: string) {
  const currency = fieldCurrency(order.metadata, "amount", fallbackCurrency);
  const payment = order.paid === true ? "Paid" : "Not marked paid";
  const lines = order.items.map((it) => {
    const ownCurrency = fieldCurrency(it.metadata, "unit_price", currency);
    if (ownCurrency !== currency) throw new Error("Use the same currency for every invoice line before exporting.");
    const qty = Number(it.qty);
    const price = it.unit_price === null ? null : Number(it.unit_price);
    if (!Number.isFinite(qty) || (price !== null && !Number.isFinite(price))) throw new Error("Check the quantities and prices before exporting.");
    return { description: it.description || "Item", qty, price, total: price === null ? null : roundMoneyAmount(qty * price, currency) };
  });
  const sum = orderTotal(order.items, currency);
  return { unpriced: sum.unpriced, total: sum.complete ? sum.amount : null, reference: order.order_number || order.id, customer: order.customer_name || "Not recorded", date: order.order_date?.slice(0, 10) || "Not recorded", currency, payment, lines };
}

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function invoiceHtml(order: InvoiceOrder, fallbackCurrency: string): string {
  const d = invoice(order, fallbackCurrency);
  const money = (n: number | null) => n === null ? "Not recorded" : escape(formatStoredMoney(n, "amount", { currency: d.currency, locale: "en" }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${escape(d.reference)}</title>
<style>
@page { size: A4; margin: 18mm; }
body { font: 14px system-ui, sans-serif; color: #111; margin: 24px auto; max-width: 900px; padding: 0 16px; overflow-wrap: anywhere; }
h1 { font-size: 26px; } table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ccc; vertical-align: top; }
th:first-child { width: 45%; } thead { display: table-header-group; } tr { break-inside: avoid; }
.total { font-weight: bold; text-align: right; } @media print { body { margin: 0; padding: 0; max-width: none; } .instructions { display: none; } }
</style></head><body>
<p class="instructions">Choose Print in your browser, then Save as PDF to save this invoice.</p>
<h1>Invoice ${escape(d.reference)}</h1>
<p>Customer: ${escape(d.customer)}</p><p>Order date: ${escape(d.date)}</p><p>Payment: ${escape(d.payment)}</p>
<table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price (${escape(d.currency)})</th><th>Line total (${escape(d.currency)})</th></tr></thead>
<tbody>${d.lines.map((it) => `<tr><td>${escape(it.description)}</td><td>${escape(it.qty)}</td><td>${money(it.price)}</td><td>${money(it.total)}</td></tr>`).join("")}</tbody></table>
<p class="total">Total (${escape(d.currency)}): ${money(d.total)}</p>
${d.total === null ? `<p>${d.unpriced === 1 ? "1 line has" : `${d.unpriced} lines have`} no price recorded. Add ${d.unpriced === 1 ? "it" : "them"} to complete the invoice total.</p>` : ""}
</body></html>`;
}

export function invoiceCsv(order: InvoiceOrder, fallbackCurrency: string): string {
  const d = invoice(order, fallbackCurrency);
  const common = [d.reference, d.customer, d.date, d.payment];
  return toCsv(["Order reference", "Customer", "Order date", "Payment status", "Line", "Description", "Quantity", "Unit price", "Line total", "Currency", "Order total"],
    d.lines.length ? d.lines.map((it, i) => [...common, i + 1, it.description, it.qty, it.price, it.total, d.currency, d.total]) : [[...common, null, null, null, null, null, d.currency, d.total]]);
}
