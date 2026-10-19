---
type: feature
scope: digifab
date: 2026-10-17
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-19
---

KUKA, FANUC, ABB and PLC-wired arms connect through an I/O board: a program is chosen by number and started over wires, with the wiring explained in plain words and safety left hardwired.

## docs

Bridge setup offers **Robot arm: KUKA (Automatic External, on I/O)**, **FANUC (UOP / PNS, on I/O)**, **ABB (system inputs, on I/O)** and **Robot arm or cell on a PLC**. Give the address of the I/O board wired to the robot, the wiring (the board's output channels, a semicolon, then its inputs, each signal=channel, like program=0-7 strobe=8 start=9 stop=10; ready=0 running=1 fault=2 ack=3) and the programs as number=name. The setup explains each brand's signals in plain words. Loading a program sets its number on the wires and waits for the robot to acknowledge it; Start, Stop and Pause are short presses. The e-stop, safeguards and enabling devices stay wired to the robot's own safety circuit, never through the board.
