---
type: fix
scope: digifab
date: 2026-08-27
---
Print updates posted to Discord arrived twice for workspaces on the hosted deployment. Two copies of the server watch the same printers there, and both were posting the same progress card. Each update is now claimed before it is sent, so it goes out once however many copies are watching. The same doubling was quietly affecting the reminder sweeps behind low-stock, expiry, parcel arrival, maintenance and reorder cadence; those now run in one place too.
