---
type: fix
scope: scan
date: 2026-07-12
---
Scanning into a named instance now defaults the confirm form's **"Add to"** to that instance immediately. Before, while the workspace's table menu was still loading, a routed scan (a yarn barcode → **Yarn**) briefly showed the generic base table (**Inventory part**) as the destination, so a fast confirm could file it into the wrong table. The routed instance is now seeded from the match itself and shown on the first render.
