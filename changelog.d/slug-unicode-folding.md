---
type: fix
scope: account
date: 2026-08-08
---
Workspace names with accented or non-English letters now make sensible web addresses. A name like "Muellers Werkstatt" or "Asas Verkstad" used to have every accented letter replaced by a dash, and a name that STARTED with one lost that letter completely, so the address quietly misspelled the name back at you. Accented letters are now folded to their plain equivalent.
