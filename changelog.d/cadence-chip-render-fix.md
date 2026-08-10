---
type: fix
date: 2026-08-10
scope: cadence
---

The buy-context chips on a re-scan never appeared. They were shown only when the system had learned a rate, but the check read a field name the server does not send, so the answer was always no.
