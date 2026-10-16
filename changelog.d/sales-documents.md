---
type: feature
scope: sales
date: 2026-10-15
docs_target: docs/USER_GUIDE.md#3.26 Sales (outbound orders)
docs_published: 2026-10-16
---
Sales orders gained quotes and numbered invoice PDFs with shop branding, tax, payment dates and email sending by the workspace owner.

## docs

**Quotes and invoices.** On an order, choose **Quote PDF** or **Invoice PDF**.
Enter the shop name, optional logo and tax percentage, and the valid-until or due
date. Choose **Create quote** or **Issue invoice** to save and download the PDF.
Every line needs a price. Quotes do not confirm orders or record payment.
Preparing a quote again updates it from the current order. An issued invoice
keeps its number, original lines, tax and total after the order changes.
Downloads no longer need the browser's print dialog.

The document card offers another download and **Email quote** or **Email invoice**.
Only the workspace owner can send; confirm the linked customer's email address
and the workspace sender before sending. Set up the sender in **Configuration,
Email** first. The message includes the document text and its PDF attachment.
Preparing or downloading a document never sends it. Cobb can offer the same
send on a confirm card; Auto mode still asks, and an assistant connection
without a card refuses. Quotes and invoices together have a limit of 20 email
attempts per workspace per hour, across the screen and assistant.

**Paid** records receipt of payment and shows its recorded date, without shipping
or fulfilling the order. Existing payments with no known date say **Not recorded**.
Unchecking Paid clears the recorded date. **Export CSV** continues to export the
current order's lines for an accounting tool.
