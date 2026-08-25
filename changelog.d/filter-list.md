---
type: feature
scope: views
date: 2026-08-24
docs_target: docs/USER_GUIDE.md#3.5 Views
---
**A view can now be filtered to several places at once, not just one.** A screen mounted between a fridge and a pantry can show both cupboards and nothing else. Filtering to a list of values used to be quietly ignored, which showed you everything instead of what you asked for; an unusable filter now shows nothing, so a mistake is visible rather than silent.

## docs

### Filtering a view to more than one place

A view filter takes either one value or a list.

```
filter: { location_id: "fridge-id" }                    one place
filter: { location_id: ["fridge-id", "pantry-id"] }     either place
```

That works for any field, not just location: a list means "any of these".

This is what lets a screen show exactly one part of a room. A tablet by the fridge and pantry shows those two and nothing else; a second one by the spice cabinets shows those. Being able to reach the right buttons without walking anywhere is most of what makes keeping track worth doing.

If a filter is written in a way Cobblr cannot use, the view now shows **nothing** rather than everything. That is deliberate: an empty view is obviously wrong and gets fixed, whereas a view quietly showing your whole kitchen looks like it is working.
