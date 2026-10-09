---
type: feature
scope: platform
date: 2026-10-09
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-10-10
---
Check my mailbox, on the Gmail connection, runs Cobblr's order rules over your whole mailbox and shows what they would file, store by store and year by year, without filing anything or asking any AI. Mark any email "Is an order" or "Isn't an order" and the next check remembers it for that sender.

## docs

**Check my mailbox before it reads for real.** On the Gmail row under **Connections**, **Check my mailbox** runs the order rules over your whole mailbox, or the dates you choose, and files nothing. It recognises an order by what the email says, not who sent it: the order details some stores build into their emails, a store platform's signs (a Shopify store's order links, even when the store sends from its own address), and the shipping, order and return rules. Nothing asks an AI; an email the rules cannot decide is shown as **would ask AI**. Only the sender, subject, date and decision of each email are kept for the report.

The report shows each year and store: how many emails were looked at, how many would be filed as orders or parcels, and how each was decided. Three lists help you check the rules:

- **Likely misses**: Gmail calls these purchases, but the rules would not file them.
- **Likely false hits**: these would be filed on one weak sign.
- **Would ask AI**: nothing decided these.

Mark any email **Is an order** or **Isn't an order**. Cobblr remembers that for its sender, and the next check shows what changed. Reading your mailbox for real this way stays off until the check has been reviewed.
