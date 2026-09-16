---
type: fix
scope: core-ai
date: 2026-09-16
---
"Remove tea category from inventory" now takes the "Teas" choice off the Category dropdown: a choice is matched the way you say it (exact, then case aside, then a unique start such as "Tea" for "Teas", and a question back when two match), the kind is worked out from the field when only one kind has it, and a list of names is read as the names. Each of those used to be a refusal, and three refusals in a row ended in directions to the settings page.
