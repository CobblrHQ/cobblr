---
type: fix
scope: core-integrations
date: 2026-09-13
---
**Importing twice in a row no longer says a sync is already running.** After an import, the connection's own poll ran again straight away and held the connection, so a second import (or Sync now) pressed seconds later was refused. The import counts as the poll's run; the next one is a cadence away.
