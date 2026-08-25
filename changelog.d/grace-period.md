---
type: feature
scope: kitchen
date: 2026-08-25
docs_target: docs/USER_GUIDE.md#3.18 Module instances ("+ New category")
---
Food stops going bad at midnight. Give an item a grace period (the "Still fine
for" field groceries already carry) and the kitchen wall shows an orange "1d
past its date, still OK" instead of flipping straight to red, and automations
that react to something expiring hold off until the grace has actually run out.
Items without a grace behave exactly as before.

## docs

A best-before date is the producer's promise, not a cliff. Set "Still fine for
(days past)" on an item and Cobblr honours it everywhere: the What's on hand
wall shows an orange "past its date, still OK ~Nd" tile during the grace, and
anything automated that hangs off an item expiring (a discard, a re-buy) waits
until the grace has run out. Leave the field empty and the date works
the way it always did.
