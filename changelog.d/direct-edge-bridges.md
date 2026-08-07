---
type: feature
scope: edge
date: 2026-07-29
docs_target: docs/USER_GUIDE.md#3.19½ Edge bridges (Configuration → Edge bridges)
docs_published: 2026-08-07
---
Edge bridges now lists the bridges Cobblr reaches directly, such as one on your own computer or a Pi on your network, alongside the ones that dial in.

## docs

The page used to show only bridges that dial in to Cobblr: you minted a token,
ran the command, and waited for the bridge to appear. A bridge Cobblr reaches
directly never dials in, so it never showed up here, and its address had to be
typed again inside every printer that used it.

Those bridges now appear in the same list, tagged **direct**, showing the address,
how many machines are configured on it, and whether a token is set. Several
machines on one bridge collapse into a single row, so a bridge running two label
printers reads as one bridge with two machines rather than two unrelated entries.

Two details worth knowing when you read a row:

**"Cobblr reached it" means Cobblr's server, not your browser.** Some things talk
to a bridge straight from the page you have open, printing labels being the main
one. Those two paths can disagree: a bridge on your home network is
reachable by a Cobblr you host there and not by a laptop somewhere else. The row
tells you which one it is reporting, so you look at the right hop.

**"Some machines have no token" is worth acting on.** It means machines on the
same bridge disagree about whether they send one, so one of them is likely to
start failing, and when it does the failure looks like a bridge problem rather
than a missing token.
