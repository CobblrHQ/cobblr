---
type: feature
scope: locations
date: 2026-10-04
docs_target: docs/USER_GUIDE.md#3.12 Locations (foundational)
---
Added bin lights through WLED or Home Assistant, with grid mapping, Show me, and picking that lights the next bin.

## docs

### Light up a bin

Add a shared WLED or Home Assistant connection in Services, then open a place and expand Light. Choose the connection and enter its LED segment, start and count, or its Home Assistant light entity. Save and test blinks it for three seconds. A thing uses its nearest place with a configured light, including a parent place.

To configure a grid at once, position the child bins in the place floorplan and choose Map all bins. A strip can follow rows or alternate direction on each row. X/Y strips light a row and a column. Mapping a grid replaces the child bins' existing light mappings.

Use Show me on a place or Where is it? in search or Cobb. Label scans and put-away destinations can also light their bins. Pick with lights on lists, builds and sales orders lights each referenced part's bin; Picked, next advances to the next item. Builds and sales use a temporary picking checklist, so picking does not change stock or fulfil an order.

Lights turn off after 30 seconds by default, or when the next bin is lit. Set a different duration on the connection. WLED also receives its own off timer, rounded up to a whole minute, so it turns off if Cobblr stops. Home Assistant uses Cobblr's timer; a Home Assistant automation can provide an independent off timer. The default lighting wires can be edited or disabled.
