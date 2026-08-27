---
type: feature
scope: integrations
date: 2026-08-27
docs_target: docs/USER_GUIDE.md#4.5f Migrate in from another app: Part-DB (`/configuration/integrations`)
---
**One-click "Import from Part-DB (live)."** Under Configuration → Integrations → *Migrate in from another app*, a new **Part-DB** card imports an electronic-component inventory in one step: paste your Part-DB address and an API token, and it brings your storage-location tree, your categories, and your parts across (name, description, stock total, minimum, manufacturer and part number, unit, supplier link, with the rest of each part's Part-DB record kept in its details). A part that Part-DB stocks in more than one place lands at its first lot's location, and the import summary tells you how many parts that applied to. When it is done it asks whether to **keep it synced** or **import just this once**; either way the connection is saved under Live sync. A Part-DB on your local network is reached through your workspace's edge bridge.

## docs

Coming from **Part-DB**? Under **Configuration → Integrations → "Migrate in from another app"** there is a **Part-DB** card.

**Part-DB: live.** Paste your Part-DB **address** and an **API token** (Part-DB → **User settings → API tokens**; a read-only token is enough). One click connects, imports your **storage locations**, then your **categories**, then your **parts**, and asks whether to **keep it synced** or **import just this once**. Either way the connection is saved under **Live sync** above, so you can re-run it, turn on ongoing sync, or archive it later. It is matched by Part-DB id, so a re-run updates in place.

What comes across: each part's name, description, comment (as notes), total stock across all its lots, minimum amount (when set), manufacturer and manufacturer part number, unit, and the first supplier's product link. Everything else on the Part-DB record (IPN, tags, mass, footprint, every lot with its bin and amount, order details and prices, parameters, EDA info) is kept in the part's details, so nothing is lost. Storage locations rebuild your **Locations** tree, and categories rebuild your **Inventory** category tree, both with their hierarchy.

**Parts stocked in more than one place.** Part-DB keeps a part's stock as lots, each in its own bin. Cobblr tracks one location per part, so a multi-lot part lands at its first lot's location with the full lot list kept on the part, and the quantity is the total across all lots. The import summary says how many parts that applied to.

**If the connection test says Part-DB refused API access:** the token is valid but its user or group lacks Part-DB's "Access API" permission. Grant it in Part-DB and try again. A LAN-only Part-DB is reached through your workspace's **edge bridge**: tick "My Part-DB is on my local network" and pick the bridge.
