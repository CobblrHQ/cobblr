---
type: feature
scope: configuration
date: 2026-07-06
---
Printed QR codes can now outlive this instance. Under **QR codes** (owner/admin), set a **Label base URL** — a stable name you control (a domain, a DuckDNS, or a Tailscale name) that forwards the `/qr/…` path to wherever your workspace lives. New codes encode that base instead of the instance's own address, so if you later self-host, change domains, or leave the hosted app, you just re-point the forward and every printed label keeps working. Leave it blank to use the current address; already-printed codes are unaffected.
