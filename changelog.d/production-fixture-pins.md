---
type: feature
date: 2026-10-10
scope: digifab
docs_target: none (documented directly in docs/modules/bench-instruments.md, Fixture pins, the seated check and bench camera evidence)
---
A production test can now drive and watch the board's pins through a fixture I/O controller on the jig: set, pulse and PWM outputs, read levels, count edges, and measure frequency, duty and edge-to-edge timing against the plan's limits. Nothing that powers or drives the board runs until the plan's "jig closed / board seated" check passes, and every run releases the fixture's pins. A plan can also keep bench camera frames for every check and a short clip of each failure.
