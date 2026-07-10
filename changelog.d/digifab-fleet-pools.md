---
type: improvement
scope: digifab
date: 2026-06-18
---
The Fleet floor now **groups machines by pool**: so a pool of individual printers (one OctoPrint here, a Klipper there) reads as one farm, with a header and a machine count, even across different connections. Machines that aren't in a pool still show under their connection. The payoff of running your printers as a Cobblr farm instead of through FDM Monster.
