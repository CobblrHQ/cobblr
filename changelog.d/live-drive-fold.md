---
type: feature
scope: platform
date: 2026-07-21
docs_target: none (design doc docs/design-decisions/live-controls.md covers it; USER_GUIDE section lands with the full Live box writeup)
---
The "Claude is driving this screen" indicator and the "use this window?" prompt now live inside the Live box instead of a separate floating banner, so there is one thing in the corner instead of two. The Live box also shows up on mobile and in top-bar layouts now, not just the full sidebar.

## docs

The old drive banner is gone. When Claude (or a scanner) drives your screen, the
Live box shows it as a row you can click to disconnect, and when something asks to
drive your window the box itself raises the "use this window?" prompt. Behind the
scenes the drive connection is unchanged; only where it appears moved. The Live box
now mounts in every layout (sidebar foot when the sidebar is full, a floating pill
otherwise), and still hides completely when there is nothing live to show.
