---
type: feature
date: 2026-10-10
scope: digifab
docs_target: none (documented directly in docs/modules/bench-instruments.md, Programming: erase, fuses, read-back and the unit's serial)
---
A production test's firmware step now reads every byte back off the chip and checks it against the firmware, can erase the chip first, sets and checks AVR fuses, and writes each board's serial to the address you choose. pyOCD joins the supported programmers.
