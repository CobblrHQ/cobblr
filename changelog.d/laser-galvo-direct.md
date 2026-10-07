---
type: feature
scope: digifab
date: 2026-10-06
docs_target: docs/USER_GUIDE.md#Direct laser jobs
docs_published: 2026-10-08
---
Added direct BJJCZ galvo jobs with lens and source confirmation, a red-guide Frame and station-only Start.

## docs

Choose **BJJCZ EZCAD2 galvo** when adding a USB machine to a bridge. The bridge
can run on Linux, Windows or macOS. Close other laser software first. If more
than one board is attached, select its unique USB serial or the complete
16-digit board ID from its setup report.

At the authorized station, load the installed lens's manufacturer COR file
and enter the field, source, frequency, pulse width, output bits, guide
alignment and manufacturer timing settings. No vendor settings are guessed.
Standby power stays off. Guide, source enable and air assist need separate
output bits. Confirm the lens, source and guide against this machine.

Use the lens field as the saved bed. A galvo has no mechanical Home in this
driver. Set focus at the machine and use zero focus offset in the material
profile. Marks use fixed power: minimum power must be zero or equal to maximum
power. If no air output is configured, set air assist manually.

Place the sheet within the confirmed field using the saved lower left origin
and orientation. Review the source, lens, frequency, pulse width and compiled
speed and power. **Frame** traces the bounding box using the separate red guide
with the marking source off. **Approve and start** belongs to the authorized
station. Pause, Resume and Stop remain available while the job runs.

Stop cancels pending USB work and switches the source and guide off. It cancels
the job and requires fresh setup before another mark. The screen keeps the
entered settings and lens file in memory for confirmation; reloading or
changing stations clears them. If USB Stop cannot be confirmed, use the
machine's physical Stop. A paused or stopped job cannot count as a good sheet.

Physical galvo hardware has not been verified. The protocol and station flow
are checked against USB controller simulators.
