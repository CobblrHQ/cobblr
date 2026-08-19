---
type: feature
scope: inventory
date: 2026-08-19
docs_target: docs/USER_GUIDE.md#3.1 Inventory
---

Ask Cobb can set stock aside for a job and settle it later. Tell it to reserve
some of a part for a project and it holds that amount without moving your
stock; when the work is done, consuming the reservation takes the stock and
puts a line on the part's statement, and releasing it simply gives the
reservation back. Cobb could move stock before but could not reserve it, so
this was the last everyday inventory job you could only do by clicking.

## docs

Ask Cobb to reserve part of your stock for a project, build or order and it
creates a reservation for that amount; your on-hand count does not change yet,
which is the point of reserving. Later, ask it to consume that reservation and
the stock comes off with a withdrawal line on the part's statement showing what
it went to, or ask it to release it and the reservation disappears with no
stock movement. A reservation can only be settled once; asking again tells you
it is already consumed rather than taking the stock twice.
