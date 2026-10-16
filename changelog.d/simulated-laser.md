---
type: feature
scope: digifab
date: 2026-10-15
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-16
---

A laser on the network (FluidNC, grblHAL or GRBL in laser mode) is recognised from its address, and a laser connected directly now opens its station page with its sheets instead of showing it unavailable.

ui: none (the station page that already exists now shows the sheets; the address field is the one connections already have)

## docs

**Add a laser by its address.** Type the IP address of a laser that runs FluidNC, grblHAL or GRBL with a web interface, and Cobblr asks the controller what it is. A controller in laser mode connects as a laser. A FluidNC controller that is not in laser mode connects as plain FluidNC. A GRBL or grblHAL CNC connects through the bridge instead.

**The laser's station page.** A laser connected straight to its controller now opens its station page with the sheets you can cut, the same as a laser behind the bridge.
