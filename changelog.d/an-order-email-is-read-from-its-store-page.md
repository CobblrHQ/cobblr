---
type: feature
scope: purchases
date: 2026-10-09
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
ui: none (the scan inbox's existing Read again and the receipt session show it; no new control)
docs_published: 2026-10-10
---
A Shopify store's order email is now read from the store's own order page when the AI can't read it: the order number, the store and every line come from the page, the order is filed in Purchases, and its order page follows from there. An order email already showing "Couldn't be read" is filed by Read again.

## docs

When a store's order email has a **View order** link, Cobblr reads that order's own page as the email arrives. The page names the order and each line, so the receipt in your scan inbox is filled from it with no AI asked, and the order goes into Purchases with its number. If an older order email says "Couldn't be read", press **Read again**: Cobblr reads it from the store page its email left behind. A store page that has stopped showing tracking numbers still names the order and its lines.
