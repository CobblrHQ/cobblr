---
type: fix
scope: labels
date: 2026-08-07
---
Labels printed by an automation (a wire firing labels:print) now carry the same full, phone-scannable QR URL as labels you print by hand, reusing the item's existing code where one was already printed. Previously they encoded a bare path that a phone camera read as plain text. If neither a label base URL nor a public instance address is configured, the automation now refuses with a clear message instead of printing a label that can never scan.
