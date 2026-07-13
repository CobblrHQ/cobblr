---
type: improvement
scope: core-scan
date: 2026-07-13
docs_target: none (docs updated in-place this PR: USER_GUIDE.md scan "Triage → commit")
---

**Scanning something you don't have a table for is a first-class flow now, not a
buried card.** When a scan's best match is a bundle you haven't installed (a VIN →
Vehicles), the closed inbox card shows a one-tap **"Install Vehicles & add"** (no
need to open it), and if you do open it, that bundle is the **default** destination
in the picker with its **real, editable fields** (year, trim, mileage, fuel,
color…) pre-filled from the scan, instead of silently defaulting to Inventory
with read-only chips. Nothing is created until you confirm; picking another table
opts out. (Also: a flaky external catalog thumbnail now falls back to your own
photo instead of showing broken on load.)
