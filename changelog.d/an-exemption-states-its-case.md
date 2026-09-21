---
type: internal
scope: platform
date: 2026-09-21
---
**A lint's exemption list states its case or does not exist.** `lint:ui-jargon` used to answer a red build by recommending `--write-baseline`, which recorded the whole current found-set: three new offences and whatever anybody added since, baselined in one command. The baseline's 35 entries were bare paths nobody could audit. Each entry now carries a `why`, a sentence somebody can disagree with, the lint refuses to run when one has no reason or names a line that is gone, and a red build hands back the one entry to add. `lint:workspace-vocab` had the same bulk write; its baseline is now shrink-only, a stale entry fails until deleted, and a new hit's only doors are to derive the word or annotate it. `scripts/lib/reasoned-baseline.ts` is the shape for the next lint that needs an allowance list.
