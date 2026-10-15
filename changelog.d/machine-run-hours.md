---
type: feature
scope: machines
date: 2026-10-15
docs_target: docs/USER_GUIDE.md#3.30 Machines
ui: none (the existing service schedule form reads machine counters)
---
Machines now track run hours from completed jobs, so service can come due after a set number of hours.

## docs

A machine keeps **run hours** from jobs completed on its linked device. Set a
service schedule to run every 200 run hours, for example, and maintenance becomes
due when the machine reaches that interval. Logging the service starts the next
interval from the current reading.

Hours use the device's reported runtime. When that is unavailable, they use time
since dispatch, including pauses and excluding time queued in Cobblr. The counter
starts at zero; earlier jobs are not added. Marking a finished part as scrap keeps
the hours the machine ran.
