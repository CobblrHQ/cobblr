---
type: feature
scope: scan
date: 2026-09-06
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Things sold by weight are recorded by weight. A receipt line like "4.14 lb at
1.99/lb" now keeps the weight, the unit and the price per unit, and counts as
one package rather than being rounded into four of them.

## docs

Some receipt lines are sold by weight rather than by count: meat, produce,
cheese from the counter. The receipt prints a weight and a price per pound or
kilo, and that is exactly what gets kept.

A weighed line shows its weight on the card, "4.14 lb", with the price per unit
beside it, "1.99/lb", in place of the quantity control. It counts as one
package, because it is one package. The weight, the unit and the per-unit price
travel with the item when it is filed, so next time you are deciding whether a
price is good you can see what you paid last time.

If the table you file into has a weight field, the weight lands there; either
way the receipt's own record on the item keeps it.
