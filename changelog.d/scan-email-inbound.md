---
type: feature
scope: core-scan
date: 2026-07-02
---
Emails can now land in Cobblr directly: forward an order confirmation or shipping notice to a workspace inbound address and its contents arrive as a routed, confirm-ready item in the scan inbox: identified and location-suggested like any other capture, instead of being read out in a chat channel. Set it up by minting an "email" inbound token; wire a mailbox to it with a Cloudflare Email Worker (docs/operations/email-inbound-capture.md).
