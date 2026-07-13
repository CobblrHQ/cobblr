---
type: feature
scope: core-scan
date: 2026-07-13
docs_target: none (docs updated in-place this PR: USER_GUIDE.md "Scan a VIN, get the vehicle")
---

**Scan a vehicle and Cobblr now fills in its color too.** It reads the **paint
code** off the door-jamb label (the one already in your scan) and resolves it to
the real color name: a built-in table covers the common makes instantly and for
free, and a code the table doesn't know is looked up with a quick web-search, so
the color fills with no AI tokens for the usual case. It only fills an empty color
field, and if it can't resolve the code it leaves it blank rather than guess.
