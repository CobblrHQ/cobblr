---
type: fix
scope: core-scan
date: 2026-10-08
---
**An order email's own photos and pack sizes are used.** Each line of an emailed order now takes the product photo printed beside it in the email, and the web is searched only for a line with no photo of its own. A filament bundle like "10KG / Multicolor" files as ten 1 kg spools, its sibling lines are read the same way, a multicolour pack reads "Mixed (10 colours)", and a code taken off the whole order is shared across the lines to the cent.
