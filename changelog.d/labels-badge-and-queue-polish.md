---
type: feature
scope: labels
date: 2026-07-12
docs_target: none (documented inline in docs/USER_GUIDE.md §3.2 this PR)
---
Five fixes to the Labels page. The code in the middle of a QR now draws as a clean circle for short codes and a stadium pill for longer ones (a two-character code used to squish into a mangled oval). You can now hide the code from the QR center per kind of thing, from the Codes panel: handy for singular kinds like a single Office where a code adds nothing. In the queue list the full label URL moved onto its own line so it is never cut off. The sheet preview now fits the column it sits in, so the second copy of a two-up label is no longer clipped. And in the Add-labels browser an already-queued row lets you take it back out: it reads "Added" and turns into "Remove" on hover.
