---
type: feature
scope: devices
date: 2026-07-30
docs_target: docs/architecture/edge-bridge-relay.md#The desktop app's own surface (port 8079)
docs_published: 2026-08-07
---
If the Cobblr desktop app is running on your computer, it now appears under Configuration, Connections, Devices with its Bluetooth printers and a connection test.

## docs

The desktop app runs a small local surface on port 8079 and Cobblr's Devices page
looks for it. When it answers, a row appears beside your bridges showing the app
version, whether its Bluetooth helper is present, and the printers this computer
is already configured for. Each one has a connection test.

The test opens the Bluetooth link once and hangs up, so macOS asks permission
every time you press it. A bridge that holds the link open asks once when it
starts instead, which is why the test is a diagnostic rather than the way to
print.

If a printer reports back nothing after connecting, something else is usually
holding it. A bridge running on the same computer keeps its printers open on
purpose, and two programs cannot own the same Bluetooth serial link.

Nothing appears here when the app is not running, and the page does not report
that as a problem.
