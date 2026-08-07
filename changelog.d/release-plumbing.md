---
type: improvement
scope: operations
date: 2026-08-07
---
Self-host releases grew their machinery: every nightly now also gets a frozen `nightly-YYYY-MM-DD` tag you can pin or cite in a bug report, a stable release is cut by re-tagging the exact nightly that soaked (no rebuild, bit-identical), and `/healthz` plus the admin Health page now report which version tag your instance runs.
