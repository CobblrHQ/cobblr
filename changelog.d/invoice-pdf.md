---
type: feature
scope: sales
date: 2026-10-04
docs_target: docs/USER_GUIDE.md#3.26 Sales (outbound orders)
---
Sales orders gained invoice PDFs saved locally through your browser and CSV export for your accounting tool, both with recorded payment state.

## docs

**Invoice PDF and payment.** On an order, use **Paid** to record receipt of
payment. Press **Invoice PDF**, then choose **Save as PDF** in your browser's
print dialog. If the invoice tab is blocked, allow pop-ups and try again. The
invoice shows the order number, customer, date, quantities, prices, total and
payment state, without a paid service. It says Paid when the order is marked
paid and Not marked paid otherwise, regardless of its shipping status.

**Accounting export.** Press **Export CSV** on the order to save its lines for
your accounting tool. Each row carries its currency and the order's payment
status. The order total repeats per line, so count it once per order when
importing. Both exports use the latest saved order. A missing price leaves the
total unrecorded until all prices are entered; mixed currencies must be made
consistent before exporting. Accounting sync, taxes and a ledger are not part
of Sales.
