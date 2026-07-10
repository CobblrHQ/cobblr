---
type: feature
date: 2026-07-08
---
**Saved views got a real builder, and sorting now works everywhere.** Creating or editing a view is now a field-aware form instead of a raw text box: pick filter fields and operators from dropdowns (`is`, `is any of`, `is not`, and numeric comparisons), pick columns and a group-by field, and (new) add **sort** rows to order a view by any field, ascending or descending, with tie-breaks. "Is any of" lets one filter match several values at once (e.g. machines that are *building* or *rebuilding*). Sorting is now honored by every module's list (machines, assets, and orders join inventory and projects), so you can finally order your things by most-recently-updated, cost, priority, or whatever field matters.
