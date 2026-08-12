---
type: fix
scope: scan
date: 2026-08-12
---
**A re-run can no longer rename your item to a worse name.** When the AI was unreachable, scan fell back to its keyword heuristic, and that fallback's guess was written back over the name something better had already produced. A "Voron 0.1 3D Printer (partially built)" came back as "Voron 0". Two faults, both fixed: the keyword fallback read the decimal in a model number as the end of a sentence, so "0.1" truncated to "0", "1.75mm" lost its leading digit and "v2.4" became "v2"; and nothing stopped that fallback from renaming a row it had no better information about. The keyword fallback now routes and fills fields as before, but it never renames. Only a real reconciliation does.
