---
type: feature
scope: platform
date: 2026-07-14
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
---
**A custom field can now target any class of things you can describe, not just two canned ones.** Yesterday's release let a field apply to "all physical items" or "all digital items". Those were the only two choices, which quietly implied the rest of the vocabulary did not exist. It does: every entity kind in Cobblr declares what it fundamentally *is* along six axes (is it physical or digital, tracked one by one or by quantity, does it hold other things, does it have a schedule, can it be finished, does it stick around). On the `/fields` page, picking **A class of things** now gives you the full grid. Tick the traits you mean and the page shows you, live, exactly which kinds the field will land on. Ticks in the same row are OR'd, and across rows they are AND'd, so "physical + tracked one by one" means assets, machines, and vehicles but **not** parts (a part is physical, but you track it by quantity). Four one-click presets sit above the grid for the common cases. It is the same control the Actions page uses to decide which entities an action appears on, so the two now behave identically.

## docs

A field can be attached to **one entity kind**, or to a **class of them**.

Pick **A class of things** and you get the trait grid. Every entity kind declares what it fundamentally is along six axes, and you tick the ones you mean:

| Axis | Poles |
|---|---|
| Tangibility | physical · digital |
| Identity | fungible (tracked by quantity) · unique (tracked one by one) |
| Containment | container (holds things) · containable (fits inside things) |
| Time | schedulable (has a when) · timeless |
| Lifecycle | completable (can be finished) · indefinite |
| Persistence | durable · ephemeral |

**Ticks in the same row are OR'd. Ticks across rows are AND'd.** So `physical` alone reaches parts, assets, machines, vehicles and locations, while `physical + unique` means "physical things you track one by one", which reaches assets, machines and vehicles but **not** parts, because a part is physical yet fungible. As you tick, the page lists the exact entity kinds the field will land on, so an abstract choice is immediately concrete, and "matches nothing" is visible before you save it.

Four presets sit above the grid as one-click shortcuts: All physical items, All digital items, Things tracked one by one, and Countable stock. They set the grid, and you can adjust from there.

The field is created **once**. It is not copied per kind, and a kind you start tracking next month inherits it automatically if it matches. To override it on a single kind, add a field with the same name to that kind: the more specific one wins there, and the class-wide one keeps applying everywhere else.
