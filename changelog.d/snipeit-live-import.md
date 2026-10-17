---
type: feature
scope: integrations
date: 2026-10-16
docs_target: docs/USER_GUIDE.md#4.5g A live sync never overwrites what you changed (`/configuration/integrations`)
docs_published: 2026-10-17
---

Assets and locations from a Snipe-IT instance import with their serial numbers, asset tags, prices and pictures, and can be kept in sync

## docs

Coming from Snipe-IT? Under **Configuration, Integrations, Migrate in**, pick **Snipe-IT**, paste your Snipe-IT address and a personal API token (Snipe-IT, Account, Manage API keys), and your assets come across: serial number, asset tag, model, maker, category, price, purchase date, warranty end, supplier and picture. The location tree rebuilds your Locations and each asset is placed where Snipe-IT has it (where it is checked out to, else its default location). The asset tag is the asset's short name, so searching the tag finds it. The serial number is kept on the asset but, as for every asset, Search does not match on it. You choose whether to import once or keep it synced; syncing again changes only what changed in Snipe-IT and never overwrites what you changed here.
