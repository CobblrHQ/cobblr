---
type: feature
scope: digifab
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#Direct laser jobs
---
Added shared USB and TCP laser connections with reviewed jobs and machine station controls.

## docs

Choose **G-code laser** when adding a machine to a bridge. Select its firmware
and either USB serial or network TCP. Use the serial port of the bridge
computer: a COM port on Windows, a /dev/cu.* device on macOS, or a stable
/dev/serial/by-id path on Linux. Keep that computer connected throughout the
job. The machine station can use any browser.

Choose **Glowforge (ForgeFIRM)** for an owner-installed ForgeFIRM machine on
TCP port 23. Stock cloud Glowforges are not supported. ForgeFIRM is beta,
third-party firmware you install at your own risk. Cobblr does not install it.
The machine's physical arming button remains part of each job.

Review the material settings and outlines at the authorized station before
Start. Stop cancels the job and invalidates the approval. A changed controller
power scale also needs a fresh review. Firmware setup confirmation and Home
belong to the station; a job never homes the machine automatically.
