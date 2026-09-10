---
type: fix
date: 2026-09-10
---
A change that moves the AI rail defers its benchmark to the nightly run, which is by design; it no longer reports that deferral as a failed check. The nightly itself could crash when every API key had spent its daily quota, which is the moment it was written to wait out; that is fixed, and scripts are now checked for names that do not exist so the class cannot ship again.
