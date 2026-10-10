---
type: feature
date: 2026-10-10
scope: digifab
docs_target: none (documented directly in docs/modules/bench-instruments.md, Debug probes: the chip, its registers and on-target tests)
---
A production test can now use a debug probe (OpenOCD, probe-rs or pyOCD over SWD or JTAG) to check that the right chip is on the board, read and write registers, reset the target, and run the board's own test firmware, judging each result line it prints over RTT, semihosting or UART against the plan's limits.
