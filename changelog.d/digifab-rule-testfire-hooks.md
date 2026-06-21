---
type: feature
---
Print-update rules gain a **"Test fire now"** button (posts a real update from the printer's current live telemetry, so you can verify a rule end-to-end without waiting), plus **pre/post hooks** — run printer controls around the post (e.g. chamber light on → settle → shoot the photo → light off). Hooks run non-blocking, so the delays never hold up telemetry.
