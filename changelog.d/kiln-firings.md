---
type: feature
scope: digifab
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-08
---
Added kiln monitoring, firing logs with linked pieces, saved schedules, shared liquid glaze use and replacement reminders by firing hours.

## docs

Open a kiln's machine record and set up **Firing logs**. You can record a
manual firing without a connection, save a schedule, choose the pieces in
the load, and finish with the measured peak, duration and outcome. Cone
charts open Orton's Celsius and Fahrenheit references.

For an ESPHome kiln-api controller, choose its connection on your shop's
central bridge. **Open kiln station** works in a browser or tablet beside
the kiln. An owner or admin authorizes that screen, checks the load and
schedule, and confirms Start there. The screen can also stop heating.
The station shows temperature, segment and elapsed time; fields the
controller does not provide stay marked unavailable.

Add elements and thermocouples in **Kiln settings** with their replacement
intervals. Recorded firing hours, including failed firings, trigger the
reminders. **Replaced now** resets a component's wear counter. Glazes kept
as Liquid workshop stock are deducted once when their recorded firing is
finished. See the contributor guide at
[Kilns and firing logs](modules/digifab-kilns.md) for interfaces and API
parity.
