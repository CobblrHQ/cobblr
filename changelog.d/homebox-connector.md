---
type: feature
scope: integrations
date: 2026-07-09
---
**Homebox is now a live sync connector.** Alongside the CSV import, you can connect a self-hosted **Homebox** instance under Configuration → Integrations → Live sync → + Add connection → **Homebox** — paste its URL + an API key. It brings your items across whole (name, quantity, cost, serial, model, manufacturer, warranty, custom fields — and each item's **photo**), rebuilds your location hierarchy, and files each item into its location. Import once, or leave the sync on to keep mirroring; matched by Homebox id so a re-run updates in place. (A quick heads-up for the curious: Homebox's API lists items in summary form and keeps locations as a tree, so the connector re-fetches each item's detail and flattens the tree — you don't need to think about any of that.)
