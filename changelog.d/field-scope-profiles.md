---
type: feature
scope: platform
date: 2026-07-14
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
---
**The class picker now offers the named shapes, not just the raw traits.** When you scope a field to a class of things, there is a second column beside the trait grid: **or a known shape**. It lists the profiles the system already uses to describe its own kinds, like `owned-thing` (a specific thing you own, tracked one by one), `stock-material` (bulk stock you count), `place` (somewhere things live), `digital-record` and `work-item`. Pick one and it ticks the grid for you, so you can take the shape closest to what you mean and adjust an axis or two, rather than assembling six axes from scratch. The preview underneath still shows exactly which kinds you will land on. Two of those profiles carry identical traits, so they show as one entry rather than two that would both light up. The renderer dropdown also stopped hogging a full row.

## docs

### Starting from a known shape

Beside the trait grid, **or a known shape** lists the profiles the system uses to describe its own entity kinds:

| Shape | What it means |
|---|---|
| `owned-thing` | A specific thing you own and track one by one: an asset, a machine, a vehicle. |
| `stock-material` | Bulk stock you count rather than name: parts, filament, screws. |
| `place` | Somewhere things live: a room, a shelf, a bin. |
| `digital-record` | A record with no physical body: a tag, a file, an entry. |
| `work-item / vendor-order` | Something with a date that can be finished. |

Picking one ticks the grid for you. It is a starting point rather than a separate mechanism, so take the shape closest to what you mean and adjust from there. The preview underneath shows exactly which kinds the field will land on.

A couple of profiles carry identical traits, so they appear as a single entry (`work-item / vendor-order`). Scoping goes by what a thing *is*, so scoping to one of them scopes to both, and showing one entry says that out loud.
