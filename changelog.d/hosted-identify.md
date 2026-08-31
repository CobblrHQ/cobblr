---
type: feature
scope: scan
date: 2026-08-31
docs_target: docs/USER_GUIDE.md#1. Quick start
---
On deployments with the hosted identify service, scanning a photo now identifies items, routes receipts, and verifies barcode matches without the workspace needing its own AI connection.

## docs

### Identify without your own AI

Some deployments (the try sandbox, hosted plans) come with identify built in.
Point the camera at a thing and Cobblr names it: brand, category, color, what
is physically in frame. Photograph a receipt and its line items land in the
scan inbox exactly as if you had forwarded the email. Scan a barcode along
with a photo and Cobblr checks the two against each other, so a wrong or
reused barcode gets caught instead of confidently mislabeling your item.

Workspaces with their own AI connection keep using it exactly as before; the
built-in service is tried first only where an operator has switched it on, and
any failure falls back to your own provider. There is a daily allowance per
workspace; past it, scans still work and simply wait for you to fill in
details by hand.
