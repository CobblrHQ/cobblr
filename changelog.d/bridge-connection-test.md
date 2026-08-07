---
type: feature
scope: printing
date: 2026-07-28
docs_target: docs/USER_GUIDE.md#Print labels over Bluetooth
docs_published: 2026-08-07
---
Test a bridge-connected printer from Cobblr and see the roll it has loaded and its battery level.

## docs

**Testing a printer on an edge bridge.** Press **Test** on the printer's row and
Cobblr connects and asks the printer about itself. A thermal label printer
answers with the roll it currently has loaded and its battery level, so you can
confirm it is ready before sending anything to it:

> Connected: 40 x 30 mm roll · battery 5/5

Reachable and ready are different questions. A printer can be perfectly
connected and still be out of labels, so the test reports what the printer said
rather than only that something answered.

If the printer cannot report on itself, the test still confirms the connection
and simply says **Connected**. Nothing is wrong; that model just has nothing to
tell you.

Two failures worth telling apart, because they have different fixes:

- **"the bridge did not answer within 90s"** means the bridge is running and the
  printer is taking too long, which almost always means it has gone to sleep or
  drifted out of range. Wake it and try again.
- **"could not reach the bridge"** means nothing answered at that address at
  all. Check the bridge is running and that the address matches where it listens.
