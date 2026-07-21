---
type: feature
scope: platform
date: 2026-07-21
docs_target: none (the design doc docs/design-decisions/live-controls.md covers it; a USER_GUIDE section lands once the mobile mount + full control set ship)
---
The workspace sidebar now has a Live box: a small, self-hiding home for ongoing session modes. When you have a printer connected, it shows an auto-print toggle right in the sidebar foot, so you can flip label auto-printing on or off at a glance instead of digging through settings.

## docs

The Live box appears at the bottom of the sidebar (in the full-sidebar layout) and
only when the workspace actually has something live to control. Each control is an
icon whose ring shows its state (green = on, grey = off); click the icon to flip
it, or expand the box for the details. Today it carries **auto-print** (shown when
a printer is connected). More live modes join it as they ship, and the box stays
hidden entirely when none apply.
