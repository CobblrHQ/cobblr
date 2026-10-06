---
type: feature
scope: digifab
date: 2026-10-06
docs_target: docs/USER_GUIDE.md#Direct laser jobs
---
Added direct Ruida laser jobs with station review, laser-off Frame and independent Stop.

## docs

Choose **Ruida DSP laser** when adding a bridge machine, then enter the
controller's IPv4 address. The bridge can run on Linux, Windows or macOS and
reach several lasers on the same network. Most cards use scramble key 88;
use 11 or 10 only when your card requires it.

At the authorized station, check the controller's bed dimensions, choose both
axis directions from its panel coordinates, and confirm that the machine
uses laser tube 1. Tube 2 stays off. Set focus at the machine and use a zero
focus offset in the material profile. Match the saved bed to the reported bed.

Clear the bed and use **Home laser** explicitly. Review the material settings
and use **Frame** to check the bounds with the laser off. **Approve and start**
uploads the compiled Ruida job only from this machine's authorized station.
Pause, Resume and Stop remain available while it runs. Stop uses a separate
control channel, cancels the job and requires fresh setup before another cut.
If the machine does not acknowledge Stop, use its physical stop.

A paused job cannot reach the outcome screen. After a completed cut, remove the
pieces and record whether they came out good before another Start. Physical
Ruida hardware has not been verified; the protocol flow is checked against
UDP controller simulators.
