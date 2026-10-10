---
type: feature
scope: core-scan
date: 2026-10-10
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
ui: the scan inbox card says "Read from the order email, no AI" (web/src/lib/documentState.ts)
---
A store's order confirmation email is now read by code, with no AI: the order number, every line named the store's way with its price, and the order's discount, checked against the email's own subtotal. A forwarded email reads the same, and an order email that said "Couldn't be read" is filed by Read again.

## docs

A store's order confirmation (the "Order #… confirmed" email most online shops send) is read without any AI. Cobblr takes the order number, each line with its variant and price, and the discount, and only files them when the lines add up to the email's own subtotal. The scan inbox card says **Read from the order email, no AI**. An email that doesn't add up is still read the usual way. If an older order email says "Couldn't be read", press **Read again**.
