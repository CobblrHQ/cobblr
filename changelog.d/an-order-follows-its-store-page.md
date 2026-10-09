---
type: feature
scope: purchases
date: 2026-10-09
docs_target: docs/USER_GUIDE.md#Tracking a parcel
docs_published: 2026-10-10
---
A Shopify store's order email has a View order link to the order's own page, which lists each line with its own tracking number. Cobblr keeps that link, sealed, and reads the page until everything is delivered, so each line gets its own number with nothing forwarded or typed.

## docs

**Following a store's own order page.** Many online stores run on Shopify, and their order email has a **View order** button. That link opens the order's page at the store, signed in, and the page lists each line with its own carrier and tracking number. When such an email reaches your receipt address, Cobblr keeps the link with the order and reads the page every few hours: each line gets its own tracking number when the store ships it, and the carrier is followed from there. It stops once everything is delivered.

The link signs you in to your account at the store, so Cobblr treats it like a password: it is stored encrypted, never shown, never put in the email it files, and never sent to an AI model. The order says which store's page it is following and how that is going.

A store's link stops working after a while, or starts showing the order without tracking numbers. When that happens the order says so, and the store's shipping emails carry the tracking from there. Cobblr never asks you to sign in for it.

On a self-hosted Cobblr this is on. An instance can turn it off with `COBBLR_ORDER_PAGE_READS=false`, which keeps the links but reads none.
