---
type: feature
date: 2026-09-20
scope: scan
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-09-23
---

Connect your Gmail once and your orders, parcels, returns and cancellations track themselves with nothing forwarded and nothing typed. Cobblr asks Google for read-only access, then reads mail from stores and carriers only (Amazon, UPS, FedEx, USPS, DHL, OnTrac, and any store you add), the last 7 days first and then as it arrives; every shipping, return, order and cancellation email lands exactly as a forwarded one would, and a delivery is a card in your DMs within minutes of the store's email. No message body is kept, nothing is labelled or sent, and Disconnect revokes the grant at Google. The card under Connections shows the mailbox, the workspace it feeds, what it reads and when it last looked, with Check now; a workspace's Integrations page lists the mailboxes feeding it. Self-hosters provide a Google client once; without one the forwarding address remains the door.

## docs

Add to the receipts-by-email section, after the forwarding recipe: Connections → Add a connection → Gmail → pick the workspace → Connect Gmail. Read-only; stores and carriers only, plus stores you add on the card; the last 7 days then live; no body kept; Check now and Disconnect on the card; a mailbox feeds one workspace; Integrations → Email in lists the mailboxes feeding a workspace; a dead grant shows "stopped: reconnect" with one card. Self-host operators: the Google client recipe in operations/gmail-mail-source.md.
