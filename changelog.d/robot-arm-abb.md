---
type: feature
scope: digifab
date: 2026-10-17
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-20
---

ABB IRC5 arms connect over Robot Web Services: programs load, start once or forever and stop from Cobblr, with the controller's write lock given back after every command.

## docs

Bridge setup offers **Robot arm: ABB IRC5 (Robot Web Services)** for an IRC5 controller on RobotWare 6 with the PC Interface option. Give the controller's address, an RWS user allowed to load and run programs and its password (entered masked; the bridge logs in with digest, so the password never crosses the network), and optionally the program folder on the controller ($HOME/Programs), the cycle (once or forever) and a cycle counter, a RAPID number your program raises at the end of each cycle, written Module/variable. Each folder there with a .pgf is a program, and it changes revision when any of its modules does. For each command the bridge takes the controller's write lock and gives it back straight after, so the FlexPendant can always take the arm back; while the pendant holds it, nothing loads or starts, and Stop is always sent. A run counts as finished only when the controller shows it finished its cycle or the counter rose. The bridge never moves the arm, releases brakes or acknowledges a stop.
