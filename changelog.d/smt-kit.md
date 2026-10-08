---
type: feature
scope: builds
date: 2026-10-06
docs_target: docs/modules/electronics-assembly.md#Work orders and kitting
docs_published: 2026-10-08
---
Added assembly work orders with whole-kit reservations and refrigerated solder paste handling against each jar's label limits.

## docs

On a board revision, create a work order for a whole board quantity and **Reserve kit**. Its list sorts component packages and blank boards by location. **Check and release kit** rechecks stock and moisture. Cancelling an unused order returns all reservations without consuming stock; quantities and revision history remain fixed.

The Solder Paste collection tracks physical jars as liquid stock in ml. Record each refrigerated jar's lot, shelf expiry and manufacturer warm-up and work-life limits. **Out of the fridge** starts both clocks. Repeating a handling action cannot reset them. Unopened jars can return to cold storage and must warm again before use; opened jars keep their work-life clock.
