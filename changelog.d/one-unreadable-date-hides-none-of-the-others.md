---
type: fix
scope: groceries
date: 2026-09-20
---

Expiry reminders no longer stop for a whole workspace because one item's date
could not be read. A best-before printed as a month alone ("2028-02", the way
a tea box or a tin prints it) used to break the hourly expiry check for
everything in the workspace, silently; it now counts as the last day of that
month, on the calendar, in the reminders and on the item. A date nothing can
read ("see lid") no longer hides the others either: the dashboard lists it
under "dates that can't be read", naming the item and the field, so you can
fix it.
