---
type: feature
scope: platform
---
**Graduation import — bring a managed app's data into a full workspace**: when someone outgrows a locked app like "Cobblr for Yarn" and starts a full Cobblr workspace from the grow door, they can tick "bring my yarn over" to copy every item — name, qty, unit, and custom fields — into the new workspace's matching instance. It's a copy, not a move: the app keeps its data and stays exactly as it was. The import re-applies the app's own installed bundle to the target first (so the instance and its fields exist there), then copies the items through the platform seam — no cross-tenant joins.
