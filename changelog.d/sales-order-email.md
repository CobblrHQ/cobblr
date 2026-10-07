---
type: feature
scope: sales
date: 2026-10-04
docs_target: docs/modules/sales.md#Automatic order intake
docs_published: 2026-10-08
---

Sales reads order emails into drafts you can review and confirm, and keeps each order in its own currency.

## docs

Forward a sales confirmation or an email placing an order to the Order emails
address in Sales settings. Recognized templates are read without AI; other
layouts use only free AI. Review the original email beside the draft, correct
its customer or lines if needed, then choose Confirm order. Emails that do not
place an order create nothing. The free IMAP order feed also accepts ordinary
plain text and HTML emails without handwritten JSON.

Imported orders keep an explicit source currency. When no currency is stated,
they use the workspace currency.
