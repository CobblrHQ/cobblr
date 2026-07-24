---
type: fix
scope: core-scan
date: 2026-07-24
---
**Emailed-receipt lines now show their progress spinner and refresh live in the scan inbox.** A receipt line gets its name from the parser, not the AI identify, so the inbox mistook it for "already done" the moment it appeared: no finishing spinner, and the inbox fell back to its slow idle refresh, so an emailed receipt looked frozen and you had to reload. Now a freshly-parsed line reads as still-working until it is routed, so its spinner runs and the inbox polls quickly to surface and update it.
