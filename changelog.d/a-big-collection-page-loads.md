---
type: fix
date: 2026-10-03
---
**A big collection's page loads.** On a workspace with a few hundred assets, the assets list and each asset page could fail with "URI Too Long" because the page asked about every record's picture in one very long address. It now asks in the body of the request, so a collection of thousands loads, and every record shows whether a picture is suggested, being looked for, or was not found.
