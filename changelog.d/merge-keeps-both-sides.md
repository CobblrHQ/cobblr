---
type: internal
scope: platform
date: 2026-10-01
---
**A merge where both sides only added things settles itself.** When a pull request and main both added an import, a registry entry, an export or a package entry at the same place, the merge step now keeps both instead of stopping for a person, and leaves every real edit alone. A pull request stacked on one that already merged is pointed at main instead of waiting on a branch that is gone.
