---
type: feature
scope: fields
date: 2026-10-01
docs_target: none (documented directly in USER_GUIDE.md, section 4.5 Custom fields)
---
Measured values: a new field type for values like 4k7, 100n or 16 V. However a value is typed (4k7, 4.7k, 4700 Ω), it is one value. It shows with the best prefix, search finds it by value and unit (10k is never the 10 kHz crystal), filters compare it and lists sort it numerically. Values typed as text before this become searchable without being changed.

## docs

Pick **measure** as a field's type on Fields & forms. Type values the way they are written on parts (`4k7`, `4.7 kΩ`, `100n`, `2.2µF`, `16 V`); the field shows what it read as you type and displays the value with its best prefix. Search for a value finds every spelling of it within 1%, in its unit; a view can filter and sort by it numerically. Imports and the assistant read values the same way.
