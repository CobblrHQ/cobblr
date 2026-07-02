---
type: improvement
date: 2026-06-20
---
Pause / resume / cancel a running print now works on **OctoPrint**, **Klipper (Moonraker)**, and **Duet** — the live-control buttons that used to be greyed out for those managers now act. Support is declared per driver (a manifest's `commands`), so any declarative manager can add control without a code change.
