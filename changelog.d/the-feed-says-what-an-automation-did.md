---
type: improvement
scope: platform
date: 2026-09-21
---
**Recent activity says what an automation did, in words.** A row for something an automation ran used to read as an event id and a reactor name in monospace ("ran an automation core-scan.scan.received → identify-photo"), which on a phone truncated to something that looked like an error, and three of the first six rows a new workspace showed were like that. The row now carries the action's own sentence for what it did, or its name, and an automation that found nothing to do no longer appears on the dashboard (it stays on the full activity page). An update whose record cannot be read any more names the field and the value that changed instead of a bare word like "type".
