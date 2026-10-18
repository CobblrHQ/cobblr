---
type: feature
scope: core-scan
date: 2026-10-17
docs_target: docs/user-guide/scan.md#3.20 Scan inbox (`core-scan`, stock)
---

Scanning within one product opens its own unit when another product shares the serial, with no question, and each scan rule shows how often its key matched more than one thing in the last 30 days.

## docs

**Scanning within one thing.** Two products can share a serial, so scanning "001" asks which one you are holding. On a pass over one product (checking a bin of Widget X), tap **Scan within this** on its Units panel, or pick one in the list with **This one, and only Widget X from now on**: from then on, a serial shared with another product opens Widget X's with no question. A chip on the camera, and in the corner wherever a scanner types into the app, says **Scanning within Widget X**; its ✕ scans the whole workspace again, and the scope ends with the browser tab anyway. Each scan rule also says how often its key matched more than one thing in the last 30 days.
