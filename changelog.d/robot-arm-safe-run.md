---
type: feature
scope: digifab
date: 2026-10-16
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
---

Robot arm runs are safe to start: one station has control at a time and the pendant always wins, a run starts only from a person's approval for that program revision and tooling, Start is sent once and never resent, and a run completes only when the arm reports it finished.

## docs

Cobb can send them too. They go out whatever the arm reports. **Open arm
station** works in a browser or tablet at the cell. An owner or admin
authorizes that screen. An operator, owner or admin there chooses **Take
control** (one station at a time, for five minutes, until it gives control
back; the pendant always wins), loads a program, checks the installed tooling
and that the cell is clear, and approves one run. The approval is for that
program revision and tooling only, and expires after 30 minutes. **Start**
then sends Start once: a run can be one invocation, a batch, an order, a
shift or continuous work, and its cycles, good parts and scrap are counted
from what the arm reports. If the arm does not confirm Start, the run reads
"Start sent, not confirmed" until Cobblr has read what the arm did; it never
sends Start again. A run completes only when the arm reports it finished; you
can end an open run as **outcome unknown**, or as **aborted** once the arm has
stopped. Every command, and who sent it from where, is listed on the arm. Cobblr never moves an arm, clears a protective or emergency stop, or
changes safety settings: do those at the pendant. See
[Robot arms](https://github.com/CobblrHQ/core/blob/main/docs/modules/digifab-robot-arms.md).
