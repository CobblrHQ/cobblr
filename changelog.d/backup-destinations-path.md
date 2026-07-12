---
type: fix
scope: configuration
date: 2026-07-13
---
Automatic backup destinations work again. The "Add a destination" button on the Backup settings page was stuck disabled because the page loaded its destinations and drivers from the wrong URL (it dropped the "/backup" path segment), so the list always came back empty. Corrected the path, so you can add and schedule a server path / NAS or Google Drive backup destination again.
