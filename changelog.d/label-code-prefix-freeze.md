---
type: fix
scope: labels
date: 2026-07-18
---
**Label code prefixes stay editable until you actually print.** A code group's prefix (the letter in front of `c1`, `m4`) is suggested automatically from the group's name, and was meant to stay editable until the first label is printed. It was actually locking itself the first time anything asked for a code, which could be as little as opening the label queue or viewing a QR, so most workspaces found their prefixes already frozen with a letter they never chose, under a tooltip claiming labels had been printed when none had. Prefixes now lock on a real print, the panel says "not printed yet, rename freely" while one can still change, and renaming a group carries its existing codes across so nothing is stranded under the old prefix.
