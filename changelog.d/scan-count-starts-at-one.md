---
type: fix
scope: scan
date: 2026-09-17
---
**A scanned item can no longer be filed with a quantity of zero.** The camera's quantity stepper never went below 1, but the filing step accepted 0, so a record could be created empty while the stepper refused to set that value afterwards. Both now follow one rule: a count starts at 1, and zero is only ever reached by using something up.
