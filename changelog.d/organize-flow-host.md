---
type: feature
scope: scan
date: 2026-07-12
docs_target: none (behavior wired now; the disassemble→sort flow is documented in the guided-organize + invokable-flows docs)
---
Disassembling a set now opens the sorting planner over exactly the parts it just spawned, so you go straight from "taken apart" to "here's a plan to bin these." More generally, any action can now hand off to a first-party flow when it finishes, and the sorting planner is reachable as one of those flows from outside the scan inbox.
