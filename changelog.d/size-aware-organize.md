---
type: feature
scope: scan
date: 2026-07-10
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-07-10
---
**Organize now knows what fits.** Tell a container its interior size (Edit location → "Interior size (mm)", optional) and give your measurement fields units, and the put-away planner stops suggesting physically impossible homes: a 300 mm drill bit never gets routed into a 100 mm bin, however similar its neighbors, and if a plan does target a tight bin, the group carries a visible "may not fit" warning instead of a silent mistake. Declared data only: no dimensions declared, no size logic. Cobblr never guesses physics from names.

## docs

- **Size-aware organizing (optional, declared-only).** Two declarations turn it on: give a container an **interior size** (Edit location → "Interior size (mm)": length × width × height, any of the three), and give your measurement fields a **unit** (a number field with unit "mm"/"in" is a length by declaration). With both present, **Organize** refuses to route an item whose longest declared dimension can't fit a bin's largest interior axis, even when every neighbor says it belongs there, and any group that still targets a tight bin (or one you re-point there yourself) shows an amber **"may not fit"** line with the numbers, so the call stays yours. Scanned items count too when their captured specs literally carry a unit ("overall length: 180 mm"). No declared dimensions anywhere? Nothing changes, the planner never guesses sizes from names or photos.
