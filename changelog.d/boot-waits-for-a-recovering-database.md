---
type: selfhost
scope: upgrade
date: 2026-09-23
---
After a power cut, the api now waits for a database that is still in crash recovery instead of exiting and being restarted in a loop. It logs "waiting for the database" every 15 seconds and starts as soon as the database answers, for up to ten minutes (`COBBLR_BOOT_DB_WAIT_MS`). A wrong password or a missing database still stops startup at once, with the database's own error.
